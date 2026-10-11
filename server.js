require('dotenv').config();

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

let odbc = null;
try {
    odbc = require('odbc');
} catch (e) {
    console.warn('[ODBC] Native node odbc module not loaded, will use Python pyodbc bridge fallback.');
}

const app = express();
const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT, 10) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const SESSION_TIMEOUT_MS = (parseInt(process.env.SESSION_TIMEOUT_MINUTES, 10) || 120) * 60 * 1000;
const ADMIN_USERS = (process.env.ADMIN_USERS || 'powerplant,system,admin')
    .split(',')
    .map(u => u.trim().toLowerCase())
    .filter(Boolean);

// Trust proxy for secure cookies behind Cloudflare Tunnel or reverse proxy
app.set('trust proxy', 1);

// 1. Security Headers via Helmet
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
            // This dashboard intentionally uses legacy inline onclick handlers throughout index.html/app.js.
            // Helmet otherwise emits script-src-attr 'none', which blocks every such button handler.
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'", "https://cdn.jsdelivr.net"],
            upgradeInsecureRequests: COOKIE_SECURE ? [] : null
        }
    },
    strictTransportSecurity: COOKIE_SECURE ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false
}));

// 2. Strict Origin Policy (No permissive CORS)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
        // Only allow if in configured whitelist
        if (allowedOrigins.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
        } else {
            // Disallow untrusted external origins
            if (req.method === 'OPTIONS') {
                return res.status(403).json({ error: 'Origin not allowed by CORS policy' });
            }
        }
    }
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// 3. Body Parsing Limits (Prevent memory/DoS exhaustion)
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// 4. Rate Limiting
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 180, // Limit each IP to 180 requests per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests. Please slow down.' }
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit failed login attempts
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many failed connection attempts from this IP. Please try again after 15 minutes.' }
});

app.use('/api/', apiLimiter);

// 5. Per-User Isolated Session Management
app.use(session({
    name: 'gridpulse.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: COOKIE_SECURE,
        sameSite: 'lax',
        maxAge: SESSION_TIMEOUT_MS
    }
}));

// 6. CSRF Protection Middleware
app.use((req, res, next) => {
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    // Set non-httpOnly readable cookie so browser client can submit X-CSRF-Token header
    res.cookie('XSRF-TOKEN', req.session.csrfToken, {
        httpOnly: false,
        secure: COOKIE_SECURE,
        sameSite: 'lax',
        path: '/'
    });
    next();
});

function verifyCsrf(req, res, next) {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
        const clientToken = req.headers['x-csrf-token'] || req.body?._csrf;
        if (!clientToken || clientToken !== req.session.csrfToken) {
            return res.status(403).json({
                success: false,
                error: 'Invalid or missing CSRF token. Please refresh the page and try again.'
            });
        }
    }
    next();
}

// 7. Authentication & Authorization Middlewares
function requireAuth(req, res, next) {
    if (!req.session || !req.session.oracleSession) {
        return res.status(401).json({
            success: false,
            error: 'Authentication required. Please connect with your Oracle database credentials.'
        });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session || !req.session.oracleSession) {
        return res.status(401).json({ success: false, error: 'Authentication required.' });
    }
    if (req.session.oracleSession.role !== 'admin') {
        return res.status(403).json({
            success: false,
            error: 'Forbidden: This action requires administrator privileges.'
        });
    }
    next();
}

// 8. Error Sanitation (Never leak credentials, stack traces, or internal paths)
function sanitizeOdbcError(err, dsn = '', user = '') {
    if (!err) return 'Unknown database error occurred.';
    let rawMsg = '';
    if (err.odbcErrors && Array.isArray(err.odbcErrors) && err.odbcErrors.length > 0) {
        rawMsg = err.odbcErrors.map(e => e.message || String(e)).join(' | ');
    } else {
        rawMsg = err.message || String(err);
    }

    rawMsg = rawMsg.replace(/\x00/g, '').trim();

    if (/ORA-01017/i.test(rawMsg)) {
        return `Oracle Logon Denied (ORA-01017): Invalid username or password for user '${user || 'specified'}'.`;
    }
    if (/IM002|Data source name not found/i.test(rawMsg)) {
        return `ODBC DSN Not Found (IM002): Data source '${dsn || 'specified'}' is not configured in 64-bit ODBC Administrator (odbcad32.exe).`;
    }
    if (/IM003|Specified driver could not be loaded/i.test(rawMsg)) {
        return `ODBC Driver Error (IM003): Driver associated with DSN '${dsn}' could not be loaded. Ensure 64-bit 'Oracle in XE' driver is installed.`;
    }
    if (/ORA-12154/i.test(rawMsg)) {
        return `TNS Could Not Resolve Service (ORA-12154): Verify the Oracle service name configured in DSN setup.`;
    }
    if (/ORA-12541/i.test(rawMsg)) {
        return `Oracle TNS Listener Down (ORA-12541): Ensure the OracleXETNSListener service is running.`;
    }
    if (/ORA-01034|ORA-27101/i.test(rawMsg)) {
        return `Oracle Instance Unavailable (ORA-01034): Ensure OracleServiceXE service is started.`;
    }
    if (/ORA-28000/i.test(rawMsg)) {
        return `Oracle Account Locked (ORA-28000): The user account is locked. Please unlock it via SQL*Plus.`;
    }
    // Generic fallback for any other database error
    return rawMsg.replace(/(PWD|password)=[^;]+/gi, '$1=***');
}

function serializeValue(val) {
    if (val === null || val === undefined) return null;
    if (val instanceof Date) return val.toISOString().split('T')[0];
    if (typeof val === 'bigint') return Number(val);
    if (Buffer.isBuffer(val)) return val.toString('utf-8');
    return val;
}

// Oracle SQL Reserved Words Set
const ORACLE_RESERVED = new Set([
    'ACCESS', 'ADD', 'ALL', 'ALTER', 'AND', 'ANY', 'AS', 'ASC', 'AUDIT', 'BETWEEN', 'BY', 'CHAR',
    'CHECK', 'CLUSTER', 'COLUMN', 'COMMENT', 'COMPRESS', 'CONNECT', 'CREATE', 'CURRENT', 'DATE',
    'DECIMAL', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'ELSE', 'EXCLUSIVE', 'EXISTS', 'FILE',
    'FLOAT', 'FOR', 'FROM', 'GRANT', 'GROUP', 'HAVING', 'IDENTIFIED', 'IMMEDIATE', 'IN', 'INCREMENT',
    'INDEX', 'INITIAL', 'INSERT', 'INTEGER', 'INTERSECT', 'INTO', 'IS', 'LEVEL', 'LIKE', 'LOCK', 'LONG',
    'MAXEXTENTS', 'MINUS', 'MODE', 'MODIFY', 'NOAUDIT', 'NOCOMPRESS', 'NOT', 'NOWAIT', 'NULL', 'NUMBER',
    'OF', 'OFFLINE', 'ON', 'ONLINE', 'OPTION', 'OR', 'ORDER', 'PCTFREE', 'PRIOR', 'PRIVILEGES', 'PUBLIC',
    'RAW', 'RENAME', 'RESOURCE', 'REVOKE', 'ROW', 'ROWID', 'ROWNUM', 'ROWS', 'SELECT', 'SESSION', 'SET',
    'SHARE', 'SIZE', 'SMALLINT', 'START', 'SUCCESSFUL', 'SYNONYM', 'SYSDATE', 'TABLE', 'THEN', 'TO',
    'TRIGGER', 'UID', 'UNION', 'UNIQUE', 'UPDATE', 'USER', 'VALIDATE', 'VALUES', 'VARCHAR', 'VARCHAR2',
    'VIEW', 'WHENEVER', 'WHERE', 'WITH'
]);

function isValidOracleIdentifier(name) {
    if (!name || typeof name !== 'string') return false;
    const clean = name.trim().toUpperCase();
    if (clean.length < 1 || clean.length > 30) return false;
    if (!/^[A-Z][A-Z0-9_$]*$/.test(clean)) return false;
    if (ORACLE_RESERVED.has(clean)) return false;
    return true;
}

// Helper to destroy session and clear auth cookies
function destroySessionAndClearCookies(req, res) {
    res.cookie('gridpulse_logged_out', '1', { path: '/', maxAge: 24 * 60 * 60 * 1000 });
    res.clearCookie('gridpulse.sid', { path: '/' });
    res.clearCookie('XSRF-TOKEN', { path: '/' });
    if (req.session) {
        req.session.destroy(() => {
            return res.json({ success: true, message: 'Logged out successfully. Session invalidated.' });
        });
    } else {
        return res.json({ success: true, message: 'Logged out successfully.' });
    }
}

// 9. Safe Python Subprocess Bridge Execution (No shell, timed execution)
function runPythonBridge(payload) {
    return new Promise((resolve) => {
        // Validate payload structure
        if (!payload || typeof payload !== 'object' || !payload.action) {
            return resolve({ success: false, error: 'Invalid payload structure for ODBC bridge.' });
        }

        const pythonCommands = [
            { cmd: 'py', args: ['-3.13', path.join(__dirname, 'odbc_bridge.py')] },
            { cmd: 'py', args: [path.join(__dirname, 'odbc_bridge.py')] },
            { cmd: 'python', args: [path.join(__dirname, 'odbc_bridge.py')] },
            { cmd: 'python3', args: [path.join(__dirname, 'odbc_bridge.py')] }
        ];

        let attemptIndex = 0;

        function trySpawn() {
            if (attemptIndex >= pythonCommands.length) {
                return resolve({
                    success: false,
                    error: 'Unable to launch Python bridge. Ensure Node.js odbc package or Python with pyodbc is installed.'
                });
            }

            const target = pythonCommands[attemptIndex++];
            let proc;
            let timer;
            try {
                // shell: false prevents command injection
                proc = spawn(target.cmd, target.args, { shell: false, windowsHide: true });
            } catch (err) {
                return trySpawn();
            }

            // 10-second timeout failsafe
            timer = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                } catch (k) { /* ignore */ }
                resolve({ success: false, error: 'Database operation timed out after 10 seconds.' });
            }, 10000);

            let stdout = '';
            let stderr = '';

            proc.on('error', () => {
                clearTimeout(timer);
                trySpawn();
            });

            if (proc.stdout) {
                proc.stdout.on('data', data => { stdout += data.toString(); });
            }
            if (proc.stderr) {
                proc.stderr.on('data', data => { stderr += data.toString(); });
            }

            proc.on('close', (code) => {
                clearTimeout(timer);
                if (code !== 0 && !stdout) {
                    return resolve({
                        success: false,
                        error: sanitizeOdbcError(stderr || `Bridge exited with code ${code}`)
                    });
                }
                try {
                    const parsed = JSON.parse(stdout.trim());
                    resolve(parsed);
                } catch (e) {
                    resolve({
                        success: false,
                        error: sanitizeOdbcError(stdout || stderr || 'Invalid response from ODBC bridge')
                    });
                }
            });

            proc.stdin.write(JSON.stringify(payload));
            proc.stdin.end();
        }

        trySpawn();
    });
}

// Native Node ODBC Operations
async function testConnectionNative(dsn, user, password) {
    const connStr = `DSN=${dsn};UID=${user};PWD=${password}`;
    let conn;
    try {
        conn = await odbc.connect(connStr);
        await conn.query('SELECT 1 FROM DUAL');
        return { success: true };
    } catch (err) {
        return { success: false, error: sanitizeOdbcError(err, dsn, user) };
    } finally {
        if (conn) {
            try { await conn.close(); } catch (e) { /* ignore */ }
        }
    }
}

async function fetchAllTablesNative(dsn, user, password) {
    const connStr = `DSN=${dsn};UID=${user};PWD=${password}`;
    let conn;
    try {
        conn = await odbc.connect(connStr);
        const result = {
            success: true,
            POWER_PLANT: [],
            GENERATOR: [],
            EMPLOYEE: [],
            GENERATION_RECORD: [],
            MAINTENANCE_LOG: [],
            hasMaintenanceTable: false,
            hasMaintenanceNotes: false
        };

        // 1. POWER_PLANT
        try {
            const plants = await conn.query('SELECT PLANT_ID, PLANT_NAME, LOCATION, CAPACITY_MW FROM POWER_PLANT ORDER BY PLANT_ID');
            result.POWER_PLANT = Array.from(plants).map(r => ({
                PLANT_ID: serializeValue(r.PLANT_ID),
                PLANT_NAME: serializeValue(r.PLANT_NAME),
                LOCATION: serializeValue(r.LOCATION),
                CAPACITY_MW: serializeValue(r.CAPACITY_MW)
            }));
        } catch (e) {
            result.powerPlantError = sanitizeOdbcError(e, dsn, user);
        }

        // 2. GENERATOR
        try {
            const gens = await conn.query('SELECT GENERATOR_ID, PLANT_ID, GENERATOR_NAME, STATUS FROM GENERATOR ORDER BY GENERATOR_ID');
            result.GENERATOR = Array.from(gens).map(r => ({
                GENERATOR_ID: serializeValue(r.GENERATOR_ID),
                PLANT_ID: serializeValue(r.PLANT_ID),
                GENERATOR_NAME: serializeValue(r.GENERATOR_NAME),
                STATUS: serializeValue(r.STATUS)
            }));
        } catch (e) {
            result.generatorError = sanitizeOdbcError(e, dsn, user);
        }

        // 3. EMPLOYEE
        try {
            const emps = await conn.query('SELECT EMPLOYEE_ID, EMPLOYEE_NAME, ROLE, PLANT_ID FROM EMPLOYEE ORDER BY EMPLOYEE_ID');
            result.EMPLOYEE = Array.from(emps).map(r => ({
                EMPLOYEE_ID: serializeValue(r.EMPLOYEE_ID),
                EMPLOYEE_NAME: serializeValue(r.EMPLOYEE_NAME),
                ROLE: serializeValue(r.ROLE),
                PLANT_ID: serializeValue(r.PLANT_ID)
            }));
        } catch (e) {
            result.employeeError = sanitizeOdbcError(e, dsn, user);
        }

        // 4. GENERATION_RECORD
        try {
            const recs = await conn.query("SELECT RECORD_ID, PLANT_ID, TO_CHAR(GENERATION_DATE, 'YYYY-MM-DD') AS GENERATION_DATE, UNITS_GENERATED FROM GENERATION_RECORD ORDER BY RECORD_ID");
            result.GENERATION_RECORD = Array.from(recs).map(r => ({
                RECORD_ID: serializeValue(r.RECORD_ID),
                PLANT_ID: serializeValue(r.PLANT_ID),
                GENERATION_DATE: serializeValue(r.GENERATION_DATE),
                UNITS_GENERATED: serializeValue(r.UNITS_GENERATED)
            }));
        } catch (e) {
            result.recordError = sanitizeOdbcError(e, dsn, user);
        }

        // 5. MAINTENANCE_LOG
        try {
            const mColsRes = await conn.query("SELECT COLUMN_NAME FROM USER_TAB_COLUMNS WHERE TABLE_NAME = 'MAINTENANCE_LOG'");
            const mCols = Array.from(mColsRes).map(r => String(r.COLUMN_NAME).toUpperCase());
            if (mCols.length > 0) {
                result.hasMaintenanceTable = true;
                result.hasMaintenanceNotes = mCols.includes('NOTES');
                const mSql = "SELECT LOG_ID, PLANT_ID, TO_CHAR(MAINTENANCE_DATE, 'YYYY-MM-DD') AS MAINTENANCE_DATE, DESCRIPTION, COST" + 
                    (result.hasMaintenanceNotes ? ", NOTES" : "") + " FROM MAINTENANCE_LOG ORDER BY LOG_ID";
                const logs = await conn.query(mSql);
                result.MAINTENANCE_LOG = Array.from(logs).map(r => {
                    const obj = {
                        LOG_ID: serializeValue(r.LOG_ID),
                        PLANT_ID: serializeValue(r.PLANT_ID),
                        MAINTENANCE_DATE: serializeValue(r.MAINTENANCE_DATE),
                        DESCRIPTION: serializeValue(r.DESCRIPTION),
                        COST: serializeValue(r.COST)
                    };
                    if (result.hasMaintenanceNotes) obj.NOTES = serializeValue(r.NOTES);
                    return obj;
                });
            }
        } catch (e) {
            result.maintenanceError = sanitizeOdbcError(e, dsn, user);
        }

        return result;
    } catch (err) {
        return { success: false, error: sanitizeOdbcError(err, dsn, user) };
    } finally {
        if (conn) {
            try { await conn.close(); } catch (e) { /* ignore */ }
        }
    }
}

async function executeSqlNative(dsn, user, password, sql, params = []) {
    const connStr = `DSN=${dsn};UID=${user};PWD=${password}`;
    let conn;
    try {
        conn = await odbc.connect(connStr);
        // Ensure string casting for parameter array if present
        const safeParams = Array.isArray(params) ? params.map(p => (p !== null && p !== undefined ? String(p) : null)) : [];
        const result = safeParams.length > 0 
            ? await conn.query(sql, safeParams)
            : await conn.query(sql);

        let rows = [];
        let columns = [];
        if (Array.isArray(result) && result.length > 0) {
            rows = Array.from(result).map(r => {
                const rowObj = {};
                for (const k of Object.keys(r)) {
                    rowObj[k] = serializeValue(r[k]);
                }
                return rowObj;
            });
            columns = result.columns && result.columns.length > 0
                ? result.columns.map(c => c.name)
                : Object.keys(rows[0]);
        } else if (result && result.columns && result.columns.length > 0) {
            columns = result.columns.map(c => c.name);
            rows = [];
        } else {
            columns = ['STATUS'];
            const count = (result && typeof result.count === 'number' && result.count >= 0) ? result.count : 0;
            rows = [{ STATUS: `Statement executed successfully. Rows affected: ${count}` }];
        }

        return {
            success: true,
            columns,
            rows,
            rowCount: rows.length
        };
    } catch (err) {
        return { success: false, error: sanitizeOdbcError(err, dsn, user) };
    } finally {
        if (conn) {
            try { await conn.close(); } catch (e) { /* ignore */ }
        }
    }
}

async function executeScriptNative(dsn, user, password, statements = []) {
    const connStr = `DSN=${dsn};UID=${user};PWD=${password}`;
    let conn;
    try {
        conn = await odbc.connect(connStr);
        const results = [];
        for (const stmt of statements) {
            const clean = stmt.trim().replace(/;$/, '');
            if (!clean) continue;
            try {
                await conn.query(clean);
                results.push({ sql: clean, success: true });
            } catch (err) {
                results.push({ sql: clean, success: false, error: sanitizeOdbcError(err, dsn, user) });
            }
        }
        return { success: true, results };
    } catch (err) {
        return { success: false, error: sanitizeOdbcError(err, dsn, user) };
    } finally {
        if (conn) {
            try { await conn.close(); } catch (e) { /* ignore */ }
        }
    }
}

// 10. Serve Frontend Static Assets Same-Origin
app.use(express.static(path.join(__dirname, '.'), {
    maxAge: 0,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// ================= API ENDPOINTS =================

// Health-Check (No sensitive information disclosed)
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'powerplant-management-system',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// CSRF Token retrieval
app.get('/api/auth/csrf', (req, res) => {
    res.json({ csrfToken: req.session.csrfToken });
});

// ODBC Connect Endpoint (Per-User Authenticated Session Creation)
app.post('/api/odbc/connect', loginLimiter, verifyCsrf, async (req, res) => {
    const { dsn, user, password } = req.body || {};

    // Input validation
    if (!dsn || typeof dsn !== 'string' || !/^[a-zA-Z0-9_\-\.]{1,64}$/.test(dsn.trim())) {
        return res.status(400).json({ success: false, error: 'Valid ODBC DSN Name is required (alphanumeric, max 64 chars).' });
    }
    if (!user || typeof user !== 'string' || !/^[a-zA-Z0-9_\$]{1,64}$/.test(user.trim())) {
        return res.status(400).json({ success: false, error: 'Valid Oracle Username is required (alphanumeric, max 64 chars).' });
    }
    if (typeof password !== 'string' || password.length > 128) {
        return res.status(400).json({ success: false, error: 'Invalid password format.' });
    }

    const cleanDsn = dsn.trim();
    const cleanUser = user.trim();
    const cleanPass = password || '';

    let testResult = null;
    if (odbc) {
        testResult = await testConnectionNative(cleanDsn, cleanUser, cleanPass);
    } else {
        testResult = await runPythonBridge({
            action: 'test_connect',
            dsn: cleanDsn,
            user: cleanUser,
            password: cleanPass
        });
    }

    if (testResult.success) {
        // Determine role using configured ADMIN_USERS list (Least-Privilege principle)
        const isUserAdmin = ADMIN_USERS.includes(cleanUser.toLowerCase());
        const userRole = isUserAdmin ? 'admin' : 'operator';

        // Store session exclusively in req.session for this user
        req.session.oracleSession = {
            id: crypto.randomUUID(),
            dsn: cleanDsn,
            user: cleanUser,
            password: cleanPass,
            role: userRole,
            connectedAt: new Date().toISOString()
        };

        res.clearCookie('gridpulse_logged_out', { path: '/' });

        return res.json({
            success: true,
            message: `Successfully connected to Oracle via DSN [${cleanDsn}] as user [${cleanUser}].`,
            dsn: cleanDsn,
            user: cleanUser,
            role: userRole
        });
    } else {
        return res.status(401).json({
            success: false,
            error: testResult.error || 'Failed to authenticate Oracle connection.'
        });
    }
});

// Application & ODBC Logout / Disconnect Endpoints (Full Server Session Destruction & Cookie Cleared)
app.post('/api/auth/logout', verifyCsrf, (req, res) => {
    destroySessionAndClearCookies(req, res);
});

app.post('/api/odbc/disconnect', verifyCsrf, (req, res) => {
    destroySessionAndClearCookies(req, res);
});

// ODBC Session Status Endpoint (Auto-initializes with defaults if configured, otherwise reports state)
app.get('/api/odbc/status', async (req, res) => {
    const isExplicitlyLoggedOut = /(?:^|; )gridpulse_logged_out=1/.test(req.headers.cookie || '');

    // Seamless auto-connect if no session exists and user has not clicked Logout
    if ((!req.session || !req.session.oracleSession) && !isExplicitlyLoggedOut) {
        const defaultDsn = process.env.DEFAULT_ODBC_DSN || 'PowerPlantDSN';
        const defaultUser = process.env.DEFAULT_ODBC_USER;
        const defaultPass = process.env.DEFAULT_ODBC_PASSWORD;

        if (defaultUser && defaultPass) {
            try {
                let testResult = null;
                if (odbc) {
                    testResult = await testConnectionNative(defaultDsn, defaultUser, defaultPass);
                } else {
                    testResult = await runPythonBridge({
                        action: 'test_connect',
                        dsn: defaultDsn,
                        user: defaultUser,
                        password: defaultPass
                    });
                }
                if (testResult && testResult.success) {
                    const isUserAdmin = ADMIN_USERS.includes(defaultUser.toLowerCase());
                    req.session.oracleSession = {
                        id: crypto.randomUUID(),
                        dsn: defaultDsn,
                        user: defaultUser,
                        password: defaultPass,
                        role: isUserAdmin ? 'admin' : 'operator',
                        connectedAt: new Date().toISOString()
                    };
                }
            } catch (err) {
                console.warn('[AUTO-CONNECT] Default connection attempt failed:', err.message);
            }
        }
    }

    if (req.session && req.session.oracleSession) {
        const s = req.session.oracleSession;
        res.json({
            connected: true,
            dsn: s.dsn,
            user: s.user,
            role: s.role,
            connectedAt: s.connectedAt,
            csrfToken: req.session.csrfToken
        });
    } else {
        res.json({
            connected: false,
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    }
});

// Fetch All Tables (Requires Authenticated Session)
app.get('/api/odbc/data', requireAuth, async (req, res) => {
    const session = req.session.oracleSession;

    let result = null;
    if (odbc) {
        result = await fetchAllTablesNative(session.dsn, session.user, session.password);
    } else {
        result = await runPythonBridge({
            action: 'fetch_all',
            dsn: session.dsn,
            user: session.user,
            password: session.password
        });
    }

    res.json(result);
});

// Execute SQL Query (Role-Guarded: Admins have full access; Operators restricted to application CRUD)
app.post('/api/odbc/query', requireAuth, verifyCsrf, async (req, res) => {
    const session = req.session.oracleSession;
    const { sql, params } = req.body || {};

    if (!sql || typeof sql !== 'string' || !sql.trim()) {
        return res.status(400).json({ success: false, error: 'SQL query string is required.' });
    }

    const trimmedSql = sql.trim();

    // Authorization Guard: Non-admins cannot run arbitrary DDL, user management, or raw system commands
    if (session.role !== 'admin') {
        const isAllowedAppQuery = /^\s*(SELECT|INSERT\s+INTO\s+(POWER_PLANT|GENERATOR|EMPLOYEE|GENERATION_RECORD|MAINTENANCE_LOG)|UPDATE\s+(POWER_PLANT|GENERATOR|EMPLOYEE|GENERATION_RECORD|MAINTENANCE_LOG)|DELETE\s+FROM\s+(POWER_PLANT|GENERATOR|EMPLOYEE|GENERATION_RECORD|MAINTENANCE_LOG))/i.test(trimmedSql);
        
        if (!isAllowedAppQuery) {
            return res.status(403).json({
                success: false,
                error: 'Forbidden: Arbitrary SQL console and administrative DDL are restricted to authorized administrators.'
            });
        }
    }

    let result = null;
    if (odbc) {
        result = await executeSqlNative(session.dsn, session.user, session.password, trimmedSql, params);
    } else {
        result = await runPythonBridge({
            action: 'execute_sql',
            dsn: session.dsn,
            user: session.user,
            password: session.password,
            sql: trimmedSql,
            params: params || []
        });
    }

    res.json(result);
});

// Execute Schema Init Script (Administrator privilege required)
app.post('/api/odbc/init-schema', requireAuth, requireAdmin, verifyCsrf, async (req, res) => {
    const session = req.session.oracleSession;

    const statements = [
        `CREATE TABLE POWER_PLANT (PLANT_ID NUMBER PRIMARY KEY, PLANT_NAME VARCHAR2(100) NOT NULL, LOCATION VARCHAR2(100), CAPACITY_MW NUMBER)`,
        `CREATE TABLE GENERATOR (GENERATOR_ID NUMBER PRIMARY KEY, PLANT_ID NUMBER REFERENCES POWER_PLANT(PLANT_ID), GENERATOR_NAME VARCHAR2(100), STATUS VARCHAR2(20))`,
        `CREATE TABLE EMPLOYEE (EMPLOYEE_ID NUMBER PRIMARY KEY, EMPLOYEE_NAME VARCHAR2(100), ROLE VARCHAR2(50), PLANT_ID NUMBER REFERENCES POWER_PLANT(PLANT_ID))`,
        `CREATE TABLE GENERATION_RECORD (RECORD_ID NUMBER PRIMARY KEY, PLANT_ID NUMBER REFERENCES POWER_PLANT(PLANT_ID), GENERATION_DATE DATE, UNITS_GENERATED NUMBER)`
    ];

    let result = null;
    if (odbc) {
        result = await executeScriptNative(session.dsn, session.user, session.password, statements);
    } else {
        result = await runPythonBridge({
            action: 'execute_script',
            dsn: session.dsn,
            user: session.user,
            password: session.password,
            statements
        });
    }

    res.json(result);
});

// 11. Schema & Table Management Endpoints

// Get All Oracle Tables & Columns for Current User Schema
app.get('/api/odbc/tables', requireAuth, async (req, res) => {
    const session = req.session.oracleSession;
    try {
        const tablesSql = `SELECT TABLE_NAME FROM USER_TABLES ORDER BY TABLE_NAME`;
        const colsSql = `SELECT TABLE_NAME, COLUMN_ID, COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, NULLABLE FROM USER_TAB_COLUMNS ORDER BY TABLE_NAME, COLUMN_ID`;

        let tablesRes, colsRes;
        if (odbc) {
            tablesRes = await executeSqlNative(session.dsn, session.user, session.password, tablesSql);
            colsRes = await executeSqlNative(session.dsn, session.user, session.password, colsSql);
        } else {
            tablesRes = await runPythonBridge({ action: 'execute_sql', dsn: session.dsn, user: session.user, password: session.password, sql: tablesSql });
            colsRes = await runPythonBridge({ action: 'execute_sql', dsn: session.dsn, user: session.user, password: session.password, sql: colsSql });
        }

        if (!tablesRes.success) {
            return res.status(400).json({ success: false, error: tablesRes.error || 'Failed to query Oracle USER_TABLES.' });
        }

        const tables = (tablesRes.rows || []).map(r => r.TABLE_NAME);
        const columns = (colsRes.rows || []).map(r => ({
            TABLE_NAME: r.TABLE_NAME,
            COLUMN_ID: r.COLUMN_ID,
            COLUMN_NAME: r.COLUMN_NAME,
            DATA_TYPE: r.DATA_TYPE,
            DATA_LENGTH: r.DATA_LENGTH,
            NULLABLE: r.NULLABLE
        }));

        res.json({
            success: true,
            tables,
            columns
        });
    } catch (err) {
        res.status(500).json({ success: false, error: sanitizeOdbcError(err, session.dsn, session.user) });
    }
});

// Create Table Endpoint with Strict Oracle Validation & Data Dictionary Verification
app.post('/api/odbc/create-table', requireAuth, requireAdmin, verifyCsrf, async (req, res) => {
    const session = req.session.oracleSession;
    const { tableName, columns } = req.body || {};

    // 1. Validate Table Name
    if (!tableName || typeof tableName !== 'string') {
        return res.status(400).json({ success: false, error: 'Table name is required.' });
    }
    const cleanTableName = tableName.trim().toUpperCase();
    if (!isValidOracleIdentifier(cleanTableName)) {
        return res.status(400).json({
            success: false,
            error: `Invalid table name '${tableName}'. Must be 1-30 chars, start with a letter, contain only alphanumeric or underscore, and not be an Oracle reserved keyword.`
        });
    }

    // 2. Validate Columns Array
    if (!Array.isArray(columns) || columns.length === 0) {
        return res.status(400).json({ success: false, error: 'At least one column definition is required.' });
    }

    const columnDefs = [];
    const seenColNames = new Set();
    let hasPrimaryKey = false;

    for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        if (!col || typeof col !== 'object') {
            return res.status(400).json({ success: false, error: `Invalid column definition at index ${i + 1}.` });
        }

        const colName = (col.name || '').trim().toUpperCase();
        if (!isValidOracleIdentifier(colName)) {
            return res.status(400).json({
                success: false,
                error: `Invalid column name '${col.name}'. Must be 1-30 chars, start with a letter, and not be an Oracle reserved keyword.`
            });
        }
        if (seenColNames.has(colName)) {
            return res.status(400).json({ success: false, error: `Duplicate column name '${colName}' in table definition.` });
        }
        seenColNames.add(colName);

        // Validate Data Type
        const colType = (col.type || '').trim().toUpperCase();
        const validTypes = ['NUMBER', 'VARCHAR2', 'CHAR', 'DATE', 'TIMESTAMP', 'FLOAT', 'CLOB'];
        const matchedBase = validTypes.find(t => colType.startsWith(t));
        if (!matchedBase) {
            return res.status(400).json({
                success: false,
                error: `Unsupported data type '${col.type}' for column '${colName}'. Supported: NUMBER, VARCHAR2(size), CHAR(size), DATE, TIMESTAMP, FLOAT, CLOB.`
            });
        }

        let def = `${colName} ${colType}`;

        if (col.primaryKey) {
            if (hasPrimaryKey) {
                return res.status(400).json({ success: false, error: 'Multiple inline PRIMARY KEY specifications are not permitted. Only one primary key column allowed.' });
            }
            def += ' PRIMARY KEY';
            hasPrimaryKey = true;
        } else {
            if (col.notNull) def += ' NOT NULL';
            if (col.unique) def += ' UNIQUE';
        }

        if (col.references) {
            const refClean = String(col.references).trim().toUpperCase();
            if (!/^[A-Z][A-Z0-9_$]*\([A-Z][A-Z0-9_$]*\)$/.test(refClean)) {
                return res.status(400).json({ success: false, error: `Invalid foreign key reference syntax: '${col.references}'. Expected format: TABLE_NAME(COLUMN_NAME)` });
            }
            def += ` REFERENCES ${refClean}`;
        }

        columnDefs.push(def);
    }

    const ddl = `CREATE TABLE ${cleanTableName} (${columnDefs.join(', ')})`;

    // 3. Execute DDL in Oracle
    let ddlResult;
    if (odbc) {
        ddlResult = await executeSqlNative(session.dsn, session.user, session.password, ddl);
    } else {
        ddlResult = await runPythonBridge({ action: 'execute_sql', dsn: session.dsn, user: session.user, password: session.password, sql: ddl });
    }

    if (!ddlResult.success) {
        return res.status(400).json({
            success: false,
            error: ddlResult.error || `Oracle failed to execute CREATE TABLE for '${cleanTableName}'.`,
            ddl
        });
    }

    // 4. Verify in Oracle Data Dictionary (USER_TABLES)
    const verifySql = `SELECT TABLE_NAME FROM USER_TABLES WHERE TABLE_NAME = '${cleanTableName}'`;
    let verifyResult;
    if (odbc) {
        verifyResult = await executeSqlNative(session.dsn, session.user, session.password, verifySql);
    } else {
        verifyResult = await runPythonBridge({ action: 'execute_sql', dsn: session.dsn, user: session.user, password: session.password, sql: verifySql });
    }

    const tableExists = verifyResult && Array.isArray(verifyResult.rows) && verifyResult.rows.length > 0;
    if (!tableExists) {
        return res.status(500).json({
            success: false,
            error: `DDL executed but table '${cleanTableName}' could not be verified in Oracle USER_TABLES catalog.`,
            ddl
        });
    }

    res.json({
        success: true,
        tableName: cleanTableName,
        ddl,
        verified: true,
        message: `Table ${cleanTableName} successfully created and verified in Oracle Database schema (${session.dsn}). Implicit commit applied.`
    });
});

// Drop Table Endpoint (With Safety Protections for Core Schema)
app.post('/api/odbc/drop-table', requireAuth, requireAdmin, verifyCsrf, async (req, res) => {
    const session = req.session.oracleSession;
    const { tableName, forceCore } = req.body || {};

    if (!tableName || typeof tableName !== 'string') {
        return res.status(400).json({ success: false, error: 'Table name is required.' });
    }
    const cleanTableName = tableName.trim().toUpperCase();

    // Guard core tables
    const CORE_TABLES = ['POWER_PLANT', 'GENERATOR', 'EMPLOYEE', 'GENERATION_RECORD'];
    if (CORE_TABLES.includes(cleanTableName) && !forceCore) {
        return res.status(403).json({
            success: false,
            error: `Protected Schema Object: '${cleanTableName}' is a core system table and cannot be dropped.`
        });
    }

    const ddl = `DROP TABLE ${cleanTableName} CASCADE CONSTRAINTS`;
    let dropResult;
    if (odbc) {
        dropResult = await executeSqlNative(session.dsn, session.user, session.password, ddl);
    } else {
        dropResult = await runPythonBridge({ action: 'execute_sql', dsn: session.dsn, user: session.user, password: session.password, sql: ddl });
    }

    if (!dropResult.success) {
        return res.status(400).json({ success: false, error: dropResult.error || `Failed to drop table '${cleanTableName}'.` });
    }

    res.json({
        success: true,
        tableName: cleanTableName,
        message: `Table ${cleanTableName} successfully dropped from Oracle schema.`
    });
});


// SPA Fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Central Error Handler (Generic error, no stack trace or leaked secrets in response)
app.use((err, req, res, next) => {
    console.error('[Internal Error]:', err.message);
    res.status(500).json({
        success: false,
        error: 'An internal server error occurred. Please contact the administrator.'
    });
});

// Process Protection Failsafes (Prevents process exits on unexpected network/driver errors)
process.on('uncaughtException', (err) => {
    console.error('[Uncaught Exception Guarded]:', err ? err.message : err);
});

process.on('unhandledRejection', (reason) => {
    console.error('[Unhandled Rejection Guarded]:', reason);
});

// Bind to HOST (defaults to 127.0.0.1 for local isolation with Cloudflare Tunnel)
app.listen(PORT, HOST, () => {
    console.log(`====================================================`);
    console.log(`⚡ Power Plant Management System (Production Security)`);
    console.log(`📡 URL: http://${HOST}:${PORT}`);
    console.log(`🩺 Health: http://${HOST}:${PORT}/api/health`);
    console.log(`🔒 Security: Helmet, Rate-Limiting, CSRF & Per-User Sessions`);
    console.log(`🔗 ODBC Engine: ${odbc ? 'Native Node.js ODBC Driver' : 'Python pyodbc Bridge'}`);
    console.log(`====================================================`);
});
