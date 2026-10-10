const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');

let odbc = null;
try {
    odbc = require('odbc');
} catch (e) {
    console.warn('[ODBC] Native node odbc module not loaded, will use Python pyodbc bridge:', e.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Permissive local CORS for dashboard, dev tools, and file:// protocol
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (e.g. mobile apps, curl, or file:// origin 'null') or local hosts
        if (!origin || origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
            return callback(null, true);
        }
        return callback(null, true); // Permissive for local lab usage
    },
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '.')));

// Session credentials stored in memory on server (never sent back to client)
let activeSession = null;

function sanitizeOdbcError(err, dsn = '') {
    if (!err) return 'Unknown database error occurred.';
    let rawMsg = '';
    if (err.odbcErrors && Array.isArray(err.odbcErrors) && err.odbcErrors.length > 0) {
        rawMsg = err.odbcErrors.map(e => e.message || String(e)).join(' | ');
    } else {
        rawMsg = err.message || String(err);
    }

    // Strip raw null characters and clean whitespace
    rawMsg = rawMsg.replace(/\x00/g, '').trim();

    if (/ORA-01017/i.test(rawMsg)) {
        return `Oracle Logon Denied (ORA-01017): Invalid username or password. Please verify your Oracle credentials for user '${activeSession ? activeSession.user : 'specified'}'.`;
    }
    if (/IM002|Data source name not found/i.test(rawMsg)) {
        return `ODBC DSN Not Found (IM002): Data source '${dsn || 'specified'}' is not configured in Windows ODBC Administrator (odbcad32.exe). Please create a System or User DSN with that exact name pointing to Oracle XE.`;
    }
    if (/IM003|Specified driver could not be loaded/i.test(rawMsg)) {
        return `ODBC Driver Error (IM003): The driver associated with DSN '${dsn}' could not be loaded. Ensure the 64-bit Oracle ODBC driver ('Oracle in XE') is installed and matches system architecture.`;
    }
    if (/ORA-12154/i.test(rawMsg)) {
        return `TNS Could Not Resolve Service (ORA-12154): Verify the Oracle Service name (e.g. XE or ORCL) configured in your ODBC DSN setup.`;
    }
    if (/ORA-12541/i.test(rawMsg)) {
        return `Oracle TNS Listener Down (ORA-12541): No listener is active. Ensure the 'OracleXETNSListener' Windows service is started.`;
    }
    if (/ORA-01034|ORA-27101/i.test(rawMsg)) {
        return `Oracle Instance Unavailable (ORA-01034): The Oracle XE database instance is not running. Ensure 'OracleServiceXE' Windows service is started.`;
    }
    if (/ORA-28000/i.test(rawMsg)) {
        return `Oracle Account Locked (ORA-28000): The account is locked. Please unlock it via SQL*Plus or contact your lab administrator.`;
    }
    return rawMsg;
}

function serializeValue(val) {
    if (val === null || val === undefined) return null;
    if (val instanceof Date) return val.toISOString().split('T')[0];
    if (typeof val === 'bigint') return Number(val);
    if (Buffer.isBuffer(val)) return val.toString('utf-8');
    return val;
}

// Fallback Python Bridge Executor (failsafe, never crashes Node process)
function runPythonBridge(payload) {
    return new Promise((resolve) => {
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
            try {
                proc = spawn(target.cmd, target.args);
            } catch (err) {
                return trySpawn();
            }

            let stdout = '';
            let stderr = '';

            proc.on('error', () => {
                trySpawn();
            });

            if (proc.stdout) {
                proc.stdout.on('data', data => { stdout += data.toString(); });
            }
            if (proc.stderr) {
                proc.stderr.on('data', data => { stderr += data.toString(); });
            }

            proc.on('close', (code) => {
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
        return { success: false, error: sanitizeOdbcError(err, dsn) };
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
            result.powerPlantError = sanitizeOdbcError(e, dsn);
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
            result.generatorError = sanitizeOdbcError(e, dsn);
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
            result.employeeError = sanitizeOdbcError(e, dsn);
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
            result.recordError = sanitizeOdbcError(e, dsn);
        }

        // 5. Check MAINTENANCE_LOG
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
            result.maintenanceError = sanitizeOdbcError(e, dsn);
        }

        return result;
    } catch (err) {
        return { success: false, error: sanitizeOdbcError(err, dsn) };
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
        const result = await conn.query(sql, params || []);

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
        return { success: false, error: sanitizeOdbcError(err, dsn) };
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
                results.push({ sql: clean, success: false, error: sanitizeOdbcError(err, dsn) });
            }
        }
        return { success: true, results };
    } catch (err) {
        return { success: false, error: sanitizeOdbcError(err, dsn) };
    } finally {
        if (conn) {
            try { await conn.close(); } catch (e) { /* ignore */ }
        }
    }
}

// ================= API ENDPOINTS =================

// 0. Health-Check Endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'powerplant-assessment-backend',
        version: '1.0.0',
        port: PORT,
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        odbc: {
            driverEngine: odbc ? 'Native Node.js ODBC (active)' : 'Python pyodbc Bridge (fallback)',
            connected: !!activeSession,
            dsn: activeSession ? activeSession.dsn : null,
            user: activeSession ? activeSession.user : null
        }
    });
});

// 1. ODBC Connect Endpoint
app.post('/api/odbc/connect', async (req, res) => {
    const { dsn, user, password } = req.body || {};
    if (!dsn || typeof dsn !== 'string' || !dsn.trim()) {
        return res.status(400).json({ success: false, error: 'ODBC DSN Name is required.' });
    }
    if (!user || typeof user !== 'string' || !user.trim()) {
        return res.status(400).json({ success: false, error: 'Oracle Username is required.' });
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
        activeSession = {
            dsn: cleanDsn,
            user: cleanUser,
            password: cleanPass,
            connectedAt: new Date().toISOString()
        };
        return res.json({
            success: true,
            message: `Successfully connected to Oracle via DSN [${cleanDsn}] as user [${cleanUser}].`,
            dsn: cleanDsn,
            user: cleanUser
        });
    } else {
        return res.status(401).json({
            success: false,
            error: testResult.error || 'Failed to establish ODBC connection to Oracle.'
        });
    }
});

// 2. ODBC Disconnect Endpoint
app.post('/api/odbc/disconnect', (req, res) => {
    activeSession = null;
    res.json({ success: true, message: 'Disconnected from Oracle ODBC session.' });
});

// 3. ODBC Session Status Endpoint
app.get('/api/odbc/status', (req, res) => {
    if (activeSession) {
        res.json({
            connected: true,
            dsn: activeSession.dsn,
            user: activeSession.user,
            connectedAt: activeSession.connectedAt
        });
    } else {
        res.json({ connected: false });
    }
});

// 4. Fetch All Primary Database Tables
app.get('/api/odbc/data', async (req, res) => {
    if (!activeSession) {
        return res.status(401).json({ success: false, error: 'No active ODBC session. Please log in first.' });
    }

    let result = null;
    if (odbc) {
        result = await fetchAllTablesNative(activeSession.dsn, activeSession.user, activeSession.password);
    } else {
        result = await runPythonBridge({
            action: 'fetch_all',
            dsn: activeSession.dsn,
            user: activeSession.user,
            password: activeSession.password
        });
    }

    res.json(result);
});

// 5. Execute Custom SQL Query
app.post('/api/odbc/query', async (req, res) => {
    if (!activeSession) {
        return res.status(401).json({ success: false, error: 'No active ODBC session. Please log in first.' });
    }

    const { sql, params } = req.body || {};
    if (!sql || typeof sql !== 'string' || !sql.trim()) {
        return res.status(400).json({ success: false, error: 'SQL query string is required.' });
    }

    let result = null;
    if (odbc) {
        result = await executeSqlNative(activeSession.dsn, activeSession.user, activeSession.password, sql, params);
    } else {
        result = await runPythonBridge({
            action: 'execute_sql',
            dsn: activeSession.dsn,
            user: activeSession.user,
            password: activeSession.password,
            sql,
            params
        });
    }

    res.json(result);
});

// 6. Execute Schema Init Script
app.post('/api/odbc/init-schema', async (req, res) => {
    if (!activeSession) {
        return res.status(401).json({ success: false, error: 'No active ODBC session. Please log in first.' });
    }

    const statements = [
        `CREATE TABLE POWER_PLANT (PLANT_ID NUMBER PRIMARY KEY, PLANT_NAME VARCHAR2(100) NOT NULL, LOCATION VARCHAR2(100), CAPACITY_MW NUMBER)`,
        `CREATE TABLE GENERATOR (GENERATOR_ID NUMBER PRIMARY KEY, PLANT_ID NUMBER REFERENCES POWER_PLANT(PLANT_ID), GENERATOR_NAME VARCHAR2(100), STATUS VARCHAR2(20))`,
        `CREATE TABLE EMPLOYEE (EMPLOYEE_ID NUMBER PRIMARY KEY, EMPLOYEE_NAME VARCHAR2(100), ROLE VARCHAR2(50), PLANT_ID NUMBER REFERENCES POWER_PLANT(PLANT_ID))`,
        `CREATE TABLE GENERATION_RECORD (RECORD_ID NUMBER PRIMARY KEY, PLANT_ID NUMBER REFERENCES POWER_PLANT(PLANT_ID), GENERATION_DATE DATE, UNITS_GENERATED NUMBER)`
    ];

    let result = null;
    if (odbc) {
        result = await executeScriptNative(activeSession.dsn, activeSession.user, activeSession.password, statements);
    } else {
        result = await runPythonBridge({
            action: 'execute_script',
            dsn: activeSession.dsn,
            user: activeSession.user,
            password: activeSession.password,
            statements
        });
    }

    res.json(result);
});

// SPA Fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Central Error Handler (prevents server crashes)
app.use((err, req, res, next) => {
    console.error('[SERVER ERROR]:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error: ' + (err.message || 'Unexpected issue')
    });
});

app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`⚡ Power Plant Management GUI Server Running`);
    console.log(`📡 URL: http://localhost:${PORT}`);
    console.log(`🩺 Health: http://localhost:${PORT}/api/health`);
    console.log(`🔗 ODBC Engine: ${odbc ? 'Native Node.js ODBC Driver' : 'Python pyodbc Bridge'}`);
    console.log(`====================================================`);
});
