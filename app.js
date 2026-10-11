/**
 * GRIDPULSE - Live Oracle ODBC Connected Engine
 * Relational CRUD, DQL Reports & Live SQL Terminal
 */

// Application State
let DB = {
    POWER_PLANT: [],
    GENERATOR: [],
    EMPLOYEE: [],
    GENERATION_RECORD: [],
    MAINTENANCE_LOG: [],
    SCHEMA_STATE: {
        maintenanceTableCreated: false,
        maintenanceHasNotes: false
    }
};

let odbcState = {
    connected: false,
    dsn: '',
    user: '',
    connectedAt: null
};

let currentSort = { table: '', column: '', asc: true };
let currentReportIndex = 1;
let currentReportData = [];
let charts = {};
let pendingDeleteAction = null;

// Backend API Configuration (Strict Same-Origin)
const API_BASE = '';
let currentCsrfToken = '';

function getCsrfToken() {
    if (currentCsrfToken) return currentCsrfToken;
    const match = document.cookie.match(/(?:^|; )XSRF-TOKEN=([^;]*)/);
    if (match) {
        currentCsrfToken = decodeURIComponent(match[1]);
        return currentCsrfToken;
    }
    return '';
}

async function ensureCsrfToken() {
    let token = getCsrfToken();
    if (!token) {
        try {
            const res = await fetch(apiUrl('/api/auth/csrf'), { credentials: 'same-origin' });
            const data = await res.json();
            if (data && data.csrfToken) {
                currentCsrfToken = data.csrfToken;
                token = data.csrfToken;
            }
        } catch (e) { /* ignore */ }
    }
    return token;
}

function apiUrl(endpoint) {
    return `${API_BASE}${endpoint}`;
}

// Expose all functions globally immediately for early inline HTML event handlers
function exposeGlobals() {
    try {
        Object.assign(window, {
            openModal,
            closeModal,
            openAddPlant,
            openAddGenerator,
            openAddEmployee,
            openAddRecord,
            openAddMaintenance,
            openEditPlant,
            confirmDeletePlant,
            viewPlantDetails,
            openEditGenerator,
            deleteGenerator,
            openEditEmployee,
            deleteEmployee,
            openEditRecord,
            deleteRecord,
            openEditMaintenance,
            deleteMaintenance,
            savePlant,
            saveGenerator,
            saveEmployee,
            saveRecord,
            saveMaintenance,
            handleOdbcLogin,
            handleOdbcDisconnect,
            handleLogout,
            openSwitchAccountModal,
            syncDatabaseFromOracle,
            exportDatabaseSQL,
            switchTab,
            sortTable,
            exportReportCSV,
            loadReport,
            executeDDLCreateML,
            executeDDLAlterML,
            inspectSchemaColumns,
            clearSQLEditor,
            runCustomSQL,
            loadSQLPreset,
            filterGenerators,
            filterEmployees,
            filterRecords,
            showToast,
            escapeHtml,
            openCreateTableModal,
            addColumnRow,
            removeColumnRow,
            onPkChange,
            updateDdlPreview,
            handleCreateTable,
            confirmDropTable,
            loadOracleSchemaTables,
            filterCatalogTable
        });
    } catch (e) {
        console.warn('Early exposeGlobals skipped:', e);
    }
}
exposeGlobals();

// Initialization with resilient readyState check
async function initializeApp() {
    exposeGlobals();
    initNavigation();
    initGlobalSearch();
    initModals();
    await checkOdbcStatus();
    renderAllViews();
    loadReport(1);
    await loadOracleSchemaTables();

    // Auto prompt ODBC login if not connected
    if (!odbcState.connected) {
        setTimeout(() => {
            openModal('modal-odbc-login');
        }, 500);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

// ODBC Connection Management
async function checkOdbcStatus() {
    try {
        await ensureCsrfToken();
        const res = await fetch(apiUrl('/api/odbc/status'), { credentials: 'same-origin' });
        const data = await res.json();
        if (data.csrfToken) currentCsrfToken = data.csrfToken;
        if (data.connected) {
            odbcState = data;
            updateOdbcUI(true);
            await syncDatabaseFromOracle(false);
            await loadOracleSchemaTables();
        } else {
            odbcState = { connected: false, dsn: '', user: '', role: '', connectedAt: null };
            updateOdbcUI(false);
            // In unauthenticated state, clear in-memory database to prevent displaying stale account data
            DB.POWER_PLANT = [];
            DB.GENERATOR = [];
            DB.EMPLOYEE = [];
            DB.GENERATION_RECORD = [];
            DB.MAINTENANCE_LOG = [];
            DB.USER_TABLES = [];
            DB.USER_TAB_COLUMNS = [];
            renderAllViews();
        }
    } catch (e) {
        console.warn("Backend server not reached or offline, running in standby mode:", e);
        odbcState = { connected: false, dsn: '', user: '', role: '', connectedAt: null };
        updateOdbcUI(false);

        const bannerText = document.getElementById('bannerWarningText');
        if (bannerText && window.location.protocol === 'file:') {
            bannerText.innerHTML = 'Running via <code>file://</code> protocol. Please start the server using <strong>start.bat</strong> and open <a href="http://localhost:3000" style="color:inherit; text-decoration:underline;">http://localhost:3000</a>.';
        }
    }
}

function updateOdbcUI(isConnected) {
    const sidebarDot = document.getElementById('sidebarStatusDot');
    const sidebarText = document.getElementById('sidebarStatusText');
    const sidebarSub = document.getElementById('sidebarStatusSub');
    const sidebarBtnText = document.getElementById('sidebarBtnText');
    const headerDot = document.getElementById('headerPulseDot');
    const headerTitle = document.getElementById('headerOdbcTitle');
    const headerSub = document.getElementById('headerOdbcSub');
    const dbEngineName = document.getElementById('db-engine-name');
    const warningBanner = document.getElementById('dbWarningBanner');
    const btnDisconnect = document.getElementById('btnDisconnectOdbc');
    const btnSubmit = document.getElementById('btnSubmitOdbcLogin');

    // Navbar & Sidebar Account Management Controls
    const btnHeaderSwitch = document.getElementById('btnHeaderSwitchUser');
    const btnHeaderLogout = document.getElementById('btnHeaderLogout');
    const btnSidebarSwitch = document.getElementById('btnSidebarSwitchUser');
    const btnSidebarLogout = document.getElementById('btnSidebarLogout');

    // Connection Details Card in Login Modal
    const connectedDetails = document.getElementById('odbc-connected-details');
    const connDsn = document.getElementById('conn-detail-dsn');
    const connUser = document.getElementById('conn-detail-user');
    const connRole = document.getElementById('conn-detail-role');
    const modalInstructions = document.getElementById('odbc-modal-instructions');
    const modalTitle = document.getElementById('odbc-modal-title');

    if (isConnected) {
        const roleLabel = odbcState.role === 'admin' ? 'Administrator' : 'Operator';
        if (sidebarDot) sidebarDot.className = 'status-indicator-dot connected';
        if (sidebarText) sidebarText.textContent = `Connected (${odbcState.dsn})`;
        if (sidebarSub) sidebarSub.textContent = `User: ${odbcState.user} (${roleLabel})`;
        if (sidebarBtnText) sidebarBtnText.textContent = 'Connection Details';

        if (headerDot) headerDot.className = 'pulse-dot connected';
        if (headerTitle) headerTitle.textContent = `ODBC: ${odbcState.dsn}`;
        if (headerSub) headerSub.textContent = `User: ${odbcState.user} (${roleLabel})`;

        if (dbEngineName) {
            dbEngineName.textContent = `Live Oracle XE (${odbcState.dsn}) [${roleLabel}]`;
            dbEngineName.style.color = 'var(--accent-emerald)';
        }

        if (warningBanner) warningBanner.style.display = 'none';
        if (btnDisconnect) btnDisconnect.style.display = 'inline-flex';
        if (btnSubmit) btnSubmit.innerHTML = '<i class="fa-solid fa-rotate"></i> Reconnect / Switch User';

        if (btnHeaderSwitch) btnHeaderSwitch.style.display = 'inline-flex';
        if (btnHeaderLogout) btnHeaderLogout.style.display = 'inline-flex';
        if (btnSidebarSwitch) btnSidebarSwitch.style.display = 'inline-flex';
        if (btnSidebarLogout) btnSidebarLogout.style.display = 'inline-flex';

        if (connectedDetails) connectedDetails.style.display = 'block';
        if (connDsn) connDsn.textContent = odbcState.dsn;
        if (connUser) connUser.textContent = odbcState.user;
        if (connRole) connRole.textContent = roleLabel;
        if (modalTitle) modalTitle.innerHTML = '<i class="fa-solid fa-circle-check" style="color:var(--accent-emerald);"></i> Oracle Connection Details';
        if (modalInstructions) modalInstructions.textContent = 'Active Oracle session verified. To switch user or reconnect, enter new credentials below:';
    } else {
        if (sidebarDot) sidebarDot.className = 'status-indicator-dot';
        if (sidebarText) sidebarText.textContent = 'Disconnected';
        if (sidebarSub) sidebarSub.textContent = 'Click below to connect Oracle database';
        if (sidebarBtnText) sidebarBtnText.textContent = 'ODBC Login';

        if (headerDot) headerDot.className = 'pulse-dot';
        if (headerTitle) headerTitle.textContent = 'ODBC: Disconnected';
        if (headerSub) headerSub.textContent = 'Click to Login';

        if (dbEngineName) {
            dbEngineName.textContent = 'Authentication Required';
            dbEngineName.style.color = 'var(--accent-amber)';
        }

        if (warningBanner) {
            warningBanner.style.display = 'flex';
            const bText = document.getElementById('bannerWarningText');
            if (bText) bText.textContent = 'Not connected to Oracle database. Click "ODBC Login" to authenticate and access live tables.';
        }
        if (btnDisconnect) btnDisconnect.style.display = 'none';
        if (btnSubmit) btnSubmit.innerHTML = '<i class="fa-solid fa-link"></i> Connect via ODBC';

        if (btnHeaderSwitch) btnHeaderSwitch.style.display = 'none';
        if (btnHeaderLogout) btnHeaderLogout.style.display = 'none';
        if (btnSidebarSwitch) btnSidebarSwitch.style.display = 'none';
        if (btnSidebarLogout) btnSidebarLogout.style.display = 'none';

        if (connectedDetails) connectedDetails.style.display = 'none';
        if (modalTitle) modalTitle.innerHTML = '<i class="fa-solid fa-database" style="color:var(--accent-cyan);"></i> Connect Oracle Database via ODBC';
        if (modalInstructions) modalInstructions.textContent = 'Enter your Oracle ODBC DSN name and credentials to authenticate directly with Oracle XE.';
    }
}


let isOdbcSubmitting = false;

async function handleOdbcLogin(event) {
    if (event) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
    }

    if (isOdbcSubmitting) {
        return;
    }

    const dsnInput = document.getElementById('odbc-dsn');
    const userInput = document.getElementById('odbc-user');
    const passInput = document.getElementById('odbc-pass');
    const errorBox = document.getElementById('odbc-login-error');
    const errorMsg = document.getElementById('odbc-error-msg');
    const submitBtn = document.getElementById('btnSubmitOdbcLogin');

    const dsn = dsnInput ? dsnInput.value.trim() : '';
    const user = userInput ? userInput.value.trim() : '';
    const pass = passInput ? passInput.value : '';

    if (!dsn || !user) {
        if (errorBox) errorBox.style.display = 'flex';
        if (errorMsg) errorMsg.textContent = 'Both ODBC DSN Name and Oracle Username are required.';
        return;
    }

    if (errorBox) errorBox.style.display = 'none';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Authenticating with Oracle...';
    }
    isOdbcSubmitting = true;

    try {
        const csrfToken = await ensureCsrfToken();
        const res = await fetch(apiUrl('/api/odbc/connect'), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({ dsn, user, password: pass })
        });
        
        let data;
        try {
            data = await res.json();
        } catch (jsonErr) {
            throw new Error(`Server returned HTTP ${res.status} (${res.statusText || 'Non-JSON response'})`);
        }

        if (res.ok && data.success) {
            odbcState = {
                connected: true,
                dsn: data.dsn,
                user: data.user,
                role: data.role || 'operator',
                connectedAt: new Date().toISOString()
            };
            updateOdbcUI(true);
            closeModal('modal-odbc-login');
            showToast(`Connected as ${data.role === 'admin' ? 'Administrator' : 'Operator'} to Oracle [${dsn}]!`, "success");
            await syncDatabaseFromOracle(true);
            await loadOracleSchemaTables();
        } else {
            if (errorBox) errorBox.style.display = 'flex';
            if (errorMsg) errorMsg.innerHTML = `<strong>Oracle Authentication Failed:</strong><br>${escapeHtml(data.error || 'Failed to authenticate connection.')}`;
            showToast("ODBC Connection Failed", "error");
        }
    } catch (e) {
        if (errorBox) errorBox.style.display = 'flex';
        const targetHost = API_BASE || window.location.origin;
        if (e.message && (e.message.includes('Failed to fetch') || e.message.includes('NetworkError'))) {
            if (errorMsg) {
                errorMsg.innerHTML = `<strong>Backend Server Offline:</strong> Could not connect to the API server at <code>${targetHost}</code>.<br><br>` +
                    `<strong>How to fix:</strong><br>` +
                    `1. Open Command Prompt or terminal in this folder.<br>` +
                    `2. Run <code>npm start</code> or double-click <code>start.bat</code>.<br>` +
                    `3. Once running, open <a href="http://localhost:3000" target="_blank" style="color:var(--accent-cyan); text-decoration:underline;">http://localhost:3000</a> in your browser.`;
            }
        } else {
            if (errorMsg) errorMsg.innerHTML = `<strong>Connection Error:</strong> ${escapeHtml(e.message)}`;
        }
        showToast("Error connecting to backend server", "error");
    } finally {
        isOdbcSubmitting = false;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = odbcState.connected 
                ? '<i class="fa-solid fa-rotate"></i> Reconnect / Switch User'
                : '<i class="fa-solid fa-link"></i> Connect via ODBC';
        }
    }
}

window.handleOdbcLogin = handleOdbcLogin;
window.handleOdbcDisconnect = handleOdbcDisconnect;
window.handleLogout = handleLogout;
window.openSwitchAccountModal = openSwitchAccountModal;

async function handleLogout() {
    try {
        const csrfToken = await ensureCsrfToken();
        await fetch(apiUrl('/api/auth/logout'), { 
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            }
        });
    } catch (e) {
        console.warn("Logout request error:", e);
    }

    // Completely clear client session and database state
    odbcState = { connected: false, dsn: '', user: '', role: '', connectedAt: null };
    currentCsrfToken = '';
    DB = {
        POWER_PLANT: [],
        GENERATOR: [],
        EMPLOYEE: [],
        GENERATION_RECORD: [],
        MAINTENANCE_LOG: [],
        USER_TABLES: [],
        USER_TAB_COLUMNS: [],
        SCHEMA_STATE: {
            maintenanceTableCreated: false,
            maintenanceHasNotes: false
        }
    };
    localStorage.removeItem('GRIDPULSE_DB_STATE');

    updateOdbcUI(false);
    renderAllViews();
    loadOracleSchemaTables();

    // Close any open modals
    document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));

    showToast("Logged out successfully. All session state cleared.", "info");

    // Clear password in login dialog ready for another user
    const passInput = document.getElementById('odbc-pass');
    if (passInput) passInput.value = '';
    const errorBox = document.getElementById('odbc-login-error');
    if (errorBox) errorBox.style.display = 'none';

    setTimeout(() => {
        openModal('modal-odbc-login');
    }, 250);
}

async function handleOdbcDisconnect() {
    await handleLogout();
}

function openSwitchAccountModal() {
    const passInput = document.getElementById('odbc-pass');
    if (passInput) passInput.value = '';
    const errorBox = document.getElementById('odbc-login-error');
    if (errorBox) errorBox.style.display = 'none';
    const submitBtn = document.getElementById('btnSubmitOdbcLogin');
    if (submitBtn) {
        submitBtn.innerHTML = '<i class="fa-solid fa-users"></i> Switch User & Connect';
    }
    openModal('modal-odbc-login');
}

async function syncDatabaseFromOracle(showToastMessage = true) {
    if (!odbcState.connected) {
        showToast("Please log in with ODBC first to sync with Oracle database.", "error");
        openModal('modal-odbc-login');
        return;
    }

    try {
        const res = await fetch(apiUrl('/api/odbc/data'), { credentials: 'same-origin' });
        if (res.status === 401) {
            odbcState.connected = false;
            updateOdbcUI(false);
            showToast("Session expired. Please log in with ODBC again.", "error");
            openModal('modal-odbc-login');
            return;
        }

        const data = await res.json();
        if (data.success) {
            DB.POWER_PLANT = data.POWER_PLANT || [];
            DB.GENERATOR = data.GENERATOR || [];
            DB.EMPLOYEE = data.EMPLOYEE || [];
            DB.GENERATION_RECORD = data.GENERATION_RECORD || [];
            DB.MAINTENANCE_LOG = data.MAINTENANCE_LOG || [];
            DB.SCHEMA_STATE = {
                maintenanceTableCreated: !!data.hasMaintenanceTable,
                maintenanceHasNotes: !!data.hasMaintenanceNotes
            };

            saveLocalCache();
            renderAllViews();
            loadReport(currentReportIndex);
            inspectSchemaColumns();

            if (showToastMessage) {
                showToast(`Synchronized ${DB.POWER_PLANT.length} plants, ${DB.GENERATOR.length} generators, ${DB.EMPLOYEE.length} staff, ${DB.GENERATION_RECORD.length} records from Oracle.`, "success");
            }
        } else {
            showToast(`Sync warning: ${data.error}`, "error");
        }
    } catch (e) {
        console.error("Failed to sync from Oracle:", e);
        showToast("Failed to fetch data from Oracle ODBC API.", "error");
    }
}

function loadLocalState() {
    const saved = localStorage.getItem('GRIDPULSE_DB_STATE');
    if (saved) {
        try {
            DB = JSON.parse(saved);
        } catch (e) {
            console.error(e);
        }
    }
}

function saveLocalCache() {
    localStorage.setItem('GRIDPULSE_DB_STATE', JSON.stringify(DB));
}

// Navigation
function initNavigation() {
    const navItems = document.querySelectorAll('.sidebar-nav .nav-item');
    navItems.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.getAttribute('data-tab');
            switchTab(tabName);
        });
    });

    const sidebarToggle = document.getElementById('sidebarToggle');
    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('collapsed');
        });
    }

    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('mobile-open');
        });
    }
}

function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(btn => btn.classList.remove('active'));

    const targetTab = document.getElementById(`tab-${tabName}`);
    const targetNav = document.getElementById(`nav-${tabName}`);

    if (targetTab) targetTab.classList.add('active');
    if (targetNav) targetNav.classList.add('active');

    const pageTitleMap = {
        dashboard: "Dashboard Overview",
        plants: "Power Plants",
        generators: "Generators",
        employees: "Staff & Employees",
        records: "Generation Output Records",
        maintenance: "Maintenance Logs",
        reports: "DQL & SQL Analytics",
        ddl: "DDL & Schema Manager",
        sql: "Live Oracle SQL Terminal"
    };
    document.getElementById('breadcrumb-page').textContent = pageTitleMap[tabName] || tabName;

    if (tabName === 'dashboard') {
        renderDashboardCharts();
    } else if (tabName === 'reports') {
        loadReport(currentReportIndex);
    }
}

// Rendering
function renderAllViews() {
    renderKPIs();
    renderPlantsTable();
    renderGeneratorsTable();
    renderEmployeesTable();
    renderRecordsTable();
    renderMaintenanceTable();
    renderDashboardTables();
    populatePlantDropdowns();
    updateBadges();
    renderDashboardCharts();
}

function updateBadges() {
    document.getElementById('badge-plants').textContent = DB.POWER_PLANT.length;
    document.getElementById('badge-generators').textContent = DB.GENERATOR.length;
    document.getElementById('badge-employees').textContent = DB.EMPLOYEE.length;
    document.getElementById('badge-records').textContent = DB.GENERATION_RECORD.length;
    document.getElementById('badge-maintenance').textContent = DB.MAINTENANCE_LOG.length;
}

function renderKPIs() {
    const totalPlants = DB.POWER_PLANT.length;
    const totalCapacity = DB.POWER_PLANT.reduce((sum, p) => sum + Number(p.CAPACITY_MW || 0), 0);
    const activeGenerators = DB.GENERATOR.filter(g => String(g.STATUS || '').toUpperCase() === 'ACTIVE').length;
    const totalGenerators = DB.GENERATOR.length;
    const totalUnits = DB.GENERATION_RECORD.reduce((sum, r) => sum + Number(r.UNITS_GENERATED || 0), 0);
    const uniqueLocations = new Set(DB.POWER_PLANT.map(p => p.LOCATION)).size;

    document.getElementById('kpi-total-plants').textContent = totalPlants;
    document.getElementById('kpi-active-locations').textContent = `${uniqueLocations} Regional Hubs`;
    document.getElementById('kpi-total-capacity').textContent = `${totalCapacity.toLocaleString()} MW`;
    document.getElementById('kpi-active-generators').textContent = `${activeGenerators} / ${totalGenerators}`;
    document.getElementById('kpi-generator-health').textContent = `${totalGenerators ? Math.round((activeGenerators/totalGenerators)*100) : 0}% Operational`;
    document.getElementById('kpi-total-units').textContent = `${totalUnits.toLocaleString()} MWh`;
    document.getElementById('kpi-record-count').textContent = `${DB.GENERATION_RECORD.length} Logged Entries`;
}

// Power Plants Table
function renderPlantsTable(filterText = '') {
    const tbody = document.getElementById('plants-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let data = [...DB.POWER_PLANT];
    if (filterText) {
        const q = filterText.toLowerCase();
        data = data.filter(p => String(p.PLANT_NAME || '').toLowerCase().includes(q) || String(p.LOCATION || '').toLowerCase().includes(q));
    }

    if (currentSort.table === 'plants') {
        data.sort((a, b) => {
            let v1 = a[currentSort.column], v2 = b[currentSort.column];
            if (typeof v1 === 'number') return currentSort.asc ? v1 - v2 : v2 - v1;
            return currentSort.asc ? String(v1).localeCompare(String(v2)) : String(v2).localeCompare(String(v1));
        });
    }

    if (data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-dim); padding:2rem;">No power plant records in database.</td></tr>`;
        return;
    }

    data.forEach(plant => {
        const staffCount = DB.EMPLOYEE.filter(e => Number(e.PLANT_ID) === Number(plant.PLANT_ID)).length;
        const genCount = DB.GENERATOR.filter(g => Number(g.PLANT_ID) === Number(plant.PLANT_ID)).length;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><code>${plant.PLANT_ID}</code></td>
            <td><strong>${escapeHtml(plant.PLANT_NAME)}</strong></td>
            <td><i class="fa-solid fa-location-dot" style="color:var(--text-dim); margin-right:4px;"></i> ${escapeHtml(plant.LOCATION)}</td>
            <td><strong>${Number(plant.CAPACITY_MW || 0).toLocaleString()} MW</strong></td>
            <td><span class="badge badge-info">${staffCount} Staff</span></td>
            <td><span class="badge badge-primary">${genCount} Units</span></td>
            <td>
                <div style="display:flex; gap:6px;">
                    <button class="btn-icon" title="View Details" onclick="viewPlantDetails(${plant.PLANT_ID})"><i class="fa-solid fa-eye"></i></button>
                    <button class="btn-icon" title="Edit Plant" onclick="openEditPlant(${plant.PLANT_ID})"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn-icon delete" title="Delete Plant" onclick="confirmDeletePlant(${plant.PLANT_ID})"><i class="fa-solid fa-trash"></i></button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// Generators Table
function renderGeneratorsTable(statusFilter = '', textFilter = '') {
    const tbody = document.getElementById('generators-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let data = [...DB.GENERATOR];
    if (statusFilter) data = data.filter(g => String(g.STATUS || '').toLowerCase() === statusFilter.toLowerCase());
    if (textFilter) {
        const q = textFilter.toLowerCase();
        data = data.filter(g => String(g.GENERATOR_NAME || '').toLowerCase().includes(q));
    }

    if (data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-dim); padding:2rem;">No generator records found.</td></tr>`;
        return;
    }

    data.forEach(gen => {
        const plant = DB.POWER_PLANT.find(p => Number(p.PLANT_ID) === Number(gen.PLANT_ID));
        const plantName = plant ? plant.PLANT_NAME : `Plant #${gen.PLANT_ID}`;
        
        let statusBadge = 'badge-success';
        const st = String(gen.STATUS || '').toUpperCase();
        if (st === 'MAINTENANCE') statusBadge = 'badge-warning';
        else if (st === 'STANDBY') statusBadge = 'badge-info';
        else if (st === 'INACTIVE') statusBadge = 'badge-danger';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><code>${gen.GENERATOR_ID}</code></td>
            <td><strong>${escapeHtml(gen.GENERATOR_NAME)}</strong></td>
            <td><i class="fa-solid fa-industry" style="color:var(--text-dim); margin-right:4px;"></i> ${escapeHtml(plantName)}</td>
            <td><span class="badge ${statusBadge}"><i class="fa-solid fa-circle-dot"></i> ${escapeHtml(gen.STATUS)}</span></td>
            <td>
                <div style="display:flex; gap:6px;">
                    <button class="btn-icon" title="Edit Generator" onclick="openEditGenerator(${gen.GENERATOR_ID})"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn-icon delete" title="Delete Generator" onclick="deleteGenerator(${gen.GENERATOR_ID})"><i class="fa-solid fa-trash"></i></button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// Employees Table
function renderEmployeesTable(roleFilter = '', textFilter = '') {
    const tbody = document.getElementById('employees-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let data = [...DB.EMPLOYEE];
    if (roleFilter) data = data.filter(e => String(e.ROLE || '').toLowerCase().includes(roleFilter.toLowerCase()));
    if (textFilter) {
        const q = textFilter.toLowerCase();
        data = data.filter(e => String(e.EMPLOYEE_NAME || '').toLowerCase().includes(q) || String(e.ROLE || '').toLowerCase().includes(q));
    }

    if (data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-dim); padding:2rem;">No employee records found.</td></tr>`;
        return;
    }

    data.forEach(emp => {
        const plant = DB.POWER_PLANT.find(p => Number(p.PLANT_ID) === Number(emp.PLANT_ID));
        const plantName = plant ? plant.PLANT_NAME : `Plant #${emp.PLANT_ID}`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><code>${emp.EMPLOYEE_ID}</code></td>
            <td><strong>${escapeHtml(emp.EMPLOYEE_NAME)}</strong></td>
            <td><span class="badge badge-primary"><i class="fa-solid fa-id-badge"></i> ${escapeHtml(emp.ROLE)}</span></td>
            <td><i class="fa-solid fa-industry" style="color:var(--text-dim); margin-right:4px;"></i> ${escapeHtml(plantName)}</td>
            <td>
                <div style="display:flex; gap:6px;">
                    <button class="btn-icon" title="Edit Employee" onclick="openEditEmployee(${emp.EMPLOYEE_ID})"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn-icon delete" title="Delete Employee" onclick="deleteEmployee(${emp.EMPLOYEE_ID})"><i class="fa-solid fa-trash"></i></button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// Generation Records Table
function renderRecordsTable(plantFilter = '', textFilter = '') {
    const tbody = document.getElementById('records-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let data = [...DB.GENERATION_RECORD];
    if (plantFilter) data = data.filter(r => Number(r.PLANT_ID) === Number(plantFilter));
    if (textFilter) {
        const q = textFilter.toLowerCase();
        data = data.filter(r => {
            const plant = DB.POWER_PLANT.find(p => Number(p.PLANT_ID) === Number(r.PLANT_ID));
            const pName = plant ? String(plant.PLANT_NAME).toLowerCase() : '';
            return String(r.GENERATION_DATE).includes(q) || pName.includes(q);
        });
    }

    data.sort((a, b) => new Date(b.GENERATION_DATE) - new Date(a.GENERATION_DATE));

    if (data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-dim); padding:2rem;">No generation records found.</td></tr>`;
        return;
    }

    data.forEach(rec => {
        const plant = DB.POWER_PLANT.find(p => Number(p.PLANT_ID) === Number(rec.PLANT_ID));
        const plantName = plant ? plant.PLANT_NAME : `Plant #${rec.PLANT_ID}`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><code>${rec.RECORD_ID}</code></td>
            <td><i class="fa-solid fa-industry" style="color:var(--text-dim); margin-right:4px;"></i> ${escapeHtml(plantName)}</td>
            <td><i class="fa-solid fa-calendar" style="color:var(--text-dim); margin-right:4px;"></i> ${rec.GENERATION_DATE}</td>
            <td><strong>${Number(rec.UNITS_GENERATED || 0).toLocaleString()} MWh</strong></td>
            <td>
                <div style="display:flex; gap:6px;">
                    <button class="btn-icon" title="Edit Record" onclick="openEditRecord(${rec.RECORD_ID})"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn-icon delete" title="Delete Record" onclick="deleteRecord(${rec.RECORD_ID})"><i class="fa-solid fa-trash"></i></button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// Maintenance Table
function renderMaintenanceTable() {
    const tbody = document.getElementById('maintenance-tbody');
    const btnAdd = document.getElementById('btnAddMaintenanceBtn');
    const notesTh = document.getElementById('th-notes-col');

    if (!DB.SCHEMA_STATE.maintenanceTableCreated) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-dim); padding:3rem;"><strong>Table MAINTENANCE_LOG does not exist yet in Oracle.</strong><br>Execute the <code>CREATE TABLE</code> DDL demo in the DDL section first.</td></tr>`;
        if (btnAdd) btnAdd.disabled = true;
        return;
    }

    if (btnAdd) btnAdd.disabled = false;
    if (notesTh) notesTh.style.display = DB.SCHEMA_STATE.maintenanceHasNotes ? '' : 'none';

    let data = [...DB.MAINTENANCE_LOG];
    tbody.innerHTML = '';

    if (data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-dim); padding:2rem;">No maintenance logs in database.</td></tr>`;
        return;
    }

    data.forEach(log => {
        const plant = DB.POWER_PLANT.find(p => Number(p.PLANT_ID) === Number(log.PLANT_ID));
        const plantName = plant ? plant.PLANT_NAME : `Plant #${log.PLANT_ID}`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><code>${log.LOG_ID}</code></td>
            <td>${escapeHtml(plantName)}</td>
            <td>${log.MAINTENANCE_DATE}</td>
            <td>${escapeHtml(log.DESCRIPTION)}</td>
            <td><strong>$${Number(log.COST || 0).toLocaleString()}</strong></td>
            ${DB.SCHEMA_STATE.maintenanceHasNotes ? `<td><span class="badge badge-info">${escapeHtml(log.NOTES || 'N/A')}</span></td>` : ''}
            <td>
                <div style="display:flex; gap:6px;">
                    <button class="btn-icon" title="Edit Log" onclick="openEditMaintenance(${log.LOG_ID})"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn-icon delete" title="Delete Log" onclick="deleteMaintenance(${log.LOG_ID})"><i class="fa-solid fa-trash"></i></button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function renderDashboardTables() {
    const plantsTbody = document.getElementById('dashboard-plants-tbody');
    if (plantsTbody) {
        plantsTbody.innerHTML = '';
        DB.POWER_PLANT.slice(0, 4).forEach(p => {
            const genCount = DB.GENERATOR.filter(g => Number(g.PLANT_ID) === Number(p.PLANT_ID)).length;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><code>${p.PLANT_ID}</code></td>
                <td><strong>${escapeHtml(p.PLANT_NAME)}</strong></td>
                <td>${escapeHtml(p.LOCATION)}</td>
                <td><strong>${p.CAPACITY_MW} MW</strong></td>
                <td><span class="badge badge-primary">${genCount} Units</span></td>
            `;
            plantsTbody.appendChild(tr);
        });
    }

    const recordsTbody = document.getElementById('dashboard-records-tbody');
    if (recordsTbody) {
        recordsTbody.innerHTML = '';
        const recs = [...DB.GENERATION_RECORD].sort((a, b) => new Date(b.GENERATION_DATE) - new Date(a.GENERATION_DATE)).slice(0, 4);
        recs.forEach(r => {
            const plant = DB.POWER_PLANT.find(p => Number(p.PLANT_ID) === Number(r.PLANT_ID));
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><code>${r.RECORD_ID}</code></td>
                <td>${plant ? escapeHtml(plant.PLANT_NAME) : r.PLANT_ID}</td>
                <td>${r.GENERATION_DATE}</td>
                <td><strong>${r.UNITS_GENERATED} MWh</strong></td>
            `;
            recordsTbody.appendChild(tr);
        });
    }
}

function populatePlantDropdowns() {
    const dropdownIds = ['generator-plant-id', 'employee-plant-id', 'record-plant-id', 'maint-plant-id', 'filterRecordPlant'];
    dropdownIds.forEach(id => {
        const select = document.getElementById(id);
        if (!select) return;

        const isFilter = id.startsWith('filter');
        select.innerHTML = isFilter ? '<option value="">All Plants</option>' : '';

        DB.POWER_PLANT.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.PLANT_ID;
            opt.textContent = `${p.PLANT_NAME} (ID: ${p.PLANT_ID})`;
            select.appendChild(opt);
        });
    });
}

// Safe Chart.js Helpers
function renderReportChart(canvas, config) {
    if (!canvas || typeof Chart === 'undefined') return;
    try {
        if (charts.report) {
            charts.report.destroy();
            charts.report = null;
        }
        charts.report = new Chart(canvas, config);
    } catch (e) {
        console.warn('Report chart rendering skipped:', e);
    }
}

// Charts
function renderDashboardCharts() {
    if (typeof Chart === 'undefined') return;
    try {
        const ctxCap = document.getElementById('chartCapacity');
        if (ctxCap) {
            if (charts.capacity) charts.capacity.destroy();

            const labels = DB.POWER_PLANT.map(p => String(p.PLANT_NAME).split(' ')[0] + ' ' + (String(p.PLANT_NAME).split(' ')[1] || ''));
            const data = DB.POWER_PLANT.map(p => p.CAPACITY_MW);

            charts.capacity = new Chart(ctxCap, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Capacity (MW)',
                        data: data,
                        backgroundColor: 'rgba(0, 242, 254, 0.65)',
                        borderColor: '#00f2fe',
                        borderWidth: 1.5,
                        borderRadius: 6
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255, 255, 255, 0.04)' } },
                        y: { ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255, 255, 255, 0.04)' } }
                    }
                }
            });
        }

        const ctxShare = document.getElementById('chartGenerationShare');
        if (ctxShare) {
            if (charts.generation) charts.generation.destroy();

            const plantGenTotals = DB.POWER_PLANT.map(p => {
                const sum = DB.GENERATION_RECORD
                    .filter(r => Number(r.PLANT_ID) === Number(p.PLANT_ID))
                    .reduce((acc, cur) => acc + Number(cur.UNITS_GENERATED || 0), 0);
                return { name: p.PLANT_NAME, sum };
            });

            charts.generation = new Chart(ctxShare, {
                type: 'doughnut',
                data: {
                    labels: plantGenTotals.map(p => p.name),
                    datasets: [{
                        data: plantGenTotals.map(p => p.sum),
                        backgroundColor: ['#00f2fe', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'],
                        borderWidth: 2,
                        borderColor: '#111622'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'right', labels: { color: '#9ca3af' } } },
                    cutout: '68%'
                }
            });
        }
    } catch (e) {
        console.warn('Dashboard charts error:', e);
    }
}

// Reports
async function loadReport(reportIndex, btnEl = null) {
    currentReportIndex = reportIndex;
    if (btnEl) {
        document.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'));
        btnEl.classList.add('active');
    }

    const titleEl = document.getElementById('report-title');
    const badgeEl = document.getElementById('report-query-badge');
    const sqlEl = document.getElementById('report-sql-text');
    const theadEl = document.getElementById('report-thead');
    const tbodyEl = document.getElementById('report-tbody');

    if (charts.report) charts.report.destroy();
    const chartWrap = document.getElementById('reportDynamicChart');

    if (reportIndex === 1) {
        titleEl.textContent = "1. Plant-wise Generation Report";
        badgeEl.textContent = "JOIN + GROUP BY + SUM + COUNT + ORDER BY";
        const sql = "SELECT p.PLANT_NAME, p.CAPACITY_MW, NVL(SUM(g.UNITS_GENERATED), 0) AS TOTAL_UNITS, COUNT(g.RECORD_ID) AS RECORD_COUNT FROM POWER_PLANT p LEFT JOIN GENERATION_RECORD g ON p.PLANT_ID = g.PLANT_ID GROUP BY p.PLANT_NAME, p.CAPACITY_MW ORDER BY TOTAL_UNITS DESC";
        sqlEl.textContent = sql + ";";

        theadEl.innerHTML = `
            <tr>
                <th>Plant Name</th>
                <th>Capacity (MW)</th>
                <th>Total Units Generated (MWh)</th>
                <th>Record Count</th>
                <th>Average Per Entry</th>
            </tr>
        `;

        currentReportData = DB.POWER_PLANT.map(p => {
            const records = DB.GENERATION_RECORD.filter(r => Number(r.PLANT_ID) === Number(p.PLANT_ID));
            const totalUnits = records.reduce((s, r) => s + Number(r.UNITS_GENERATED || 0), 0);
            const count = records.length;
            const avg = count ? Math.round(totalUnits / count) : 0;
            return { name: p.PLANT_NAME, capacity: p.CAPACITY_MW, totalUnits, count, avg };
        }).sort((a, b) => b.totalUnits - a.totalUnits);

        tbodyEl.innerHTML = '';
        currentReportData.forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${escapeHtml(row.name)}</strong></td>
                <td>${Number(row.capacity || 0).toLocaleString()} MW</td>
                <td><strong style="color:var(--accent-cyan);">${Number(row.totalUnits || 0).toLocaleString()} MWh</strong></td>
                <td><span class="badge badge-info">${row.count} Records</span></td>
                <td>${row.avg.toLocaleString()} MWh</td>
            `;
            tbodyEl.appendChild(tr);
        });

        renderReportChart(chartWrap, {
            type: 'bar',
            data: {
                labels: currentReportData.map(r => r.name),
                datasets: [{
                    label: 'Total Units (MWh)',
                    data: currentReportData.map(r => r.totalUnits),
                    backgroundColor: 'rgba(0, 242, 254, 0.7)',
                    borderColor: '#00f2fe',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.04)' } },
                    y: { ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.04)' } }
                }
            }
        });

    } else if (reportIndex === 2) {
        titleEl.textContent = "2. Plants Ranked by Generation Capacity";
        badgeEl.textContent = "SELECT + ORDER BY CAPACITY_MW DESC";
        sqlEl.textContent = "SELECT PLANT_ID, PLANT_NAME, LOCATION, CAPACITY_MW FROM POWER_PLANT ORDER BY CAPACITY_MW DESC;";

        theadEl.innerHTML = `
            <tr>
                <th>Rank</th>
                <th>Plant ID</th>
                <th>Plant Name</th>
                <th>Location</th>
                <th>Capacity (MW)</th>
            </tr>
        `;

        currentReportData = [...DB.POWER_PLANT].sort((a, b) => Number(b.CAPACITY_MW) - Number(a.CAPACITY_MW));
        tbodyEl.innerHTML = '';
        currentReportData.forEach((row, idx) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><span class="badge ${idx === 0 ? 'badge-warning' : 'badge-primary'}">#${idx + 1}</span></td>
                <td><code>${row.PLANT_ID}</code></td>
                <td><strong>${escapeHtml(row.PLANT_NAME)}</strong></td>
                <td>${escapeHtml(row.LOCATION)}</td>
                <td><strong>${Number(row.CAPACITY_MW || 0).toLocaleString()} MW</strong></td>
            `;
            tbodyEl.appendChild(tr);
        });

        renderReportChart(chartWrap, {
            type: 'bar',
            data: {
                labels: currentReportData.map(r => r.PLANT_NAME),
                datasets: [{
                    label: 'Capacity (MW)',
                    data: currentReportData.map(r => r.CAPACITY_MW),
                    backgroundColor: 'rgba(245, 158, 11, 0.7)',
                    borderColor: '#f59e0b',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.04)' } },
                    y: { ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.04)' } }
                }
            }
        });

    } else if (reportIndex === 3) {
        titleEl.textContent = "3. Employee Staffing Distribution Per Plant";
        badgeEl.textContent = "LEFT JOIN + COUNT + GROUP BY";
        sqlEl.textContent = "SELECT p.PLANT_NAME, COUNT(e.EMPLOYEE_ID) AS EMPLOYEE_COUNT FROM POWER_PLANT p LEFT JOIN EMPLOYEE e ON p.PLANT_ID = e.PLANT_ID GROUP BY p.PLANT_NAME ORDER BY p.PLANT_NAME;";

        theadEl.innerHTML = `
            <tr>
                <th>Plant Name</th>
                <th>Employee Headcount</th>
                <th>Staff Roles Breakdown</th>
            </tr>
        `;

        currentReportData = DB.POWER_PLANT.map(p => {
            const emps = DB.EMPLOYEE.filter(e => Number(e.PLANT_ID) === Number(p.PLANT_ID));
            const roles = emps.map(e => e.ROLE).join(', ') || 'None Assigned';
            return { name: p.PLANT_NAME, count: emps.length, roles };
        });

        tbodyEl.innerHTML = '';
        currentReportData.forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${escapeHtml(row.name)}</strong></td>
                <td><span class="badge badge-success">${row.count} Personnel</span></td>
                <td><small style="color:var(--text-muted);">${escapeHtml(row.roles)}</small></td>
            `;
            tbodyEl.appendChild(tr);
        });

        renderReportChart(chartWrap, {
            type: 'bar',
            data: {
                labels: currentReportData.map(r => r.name),
                datasets: [{
                    label: 'Employees Assigned',
                    data: currentReportData.map(r => r.count),
                    backgroundColor: 'rgba(16, 185, 129, 0.7)',
                    borderColor: '#10b981',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.04)' } },
                    y: { ticks: { color: '#9ca3af', stepSize: 1 }, grid: { color: 'rgba(255,255,255,0.04)' } }
                }
            }
        });

    } else if (reportIndex === 4) {
        titleEl.textContent = "4. Generator Operational Status Overview";
        badgeEl.textContent = "GROUP BY STATUS + COUNT";
        sqlEl.textContent = "SELECT STATUS, COUNT(GENERATOR_ID) AS UNIT_COUNT FROM GENERATOR GROUP BY STATUS ORDER BY UNIT_COUNT DESC;";

        theadEl.innerHTML = `
            <tr>
                <th>Status</th>
                <th>Units Count</th>
                <th>Percentage of Grid Fleet</th>
            </tr>
        `;

        const statusCounts = {};
        DB.GENERATOR.forEach(g => {
            const st = g.STATUS || 'Unknown';
            statusCounts[st] = (statusCounts[st] || 0) + 1;
        });

        const total = DB.GENERATOR.length || 1;
        currentReportData = Object.keys(statusCounts).map(s => ({
            status: s,
            count: statusCounts[s],
            pct: ((statusCounts[s] / total) * 100).toFixed(1)
        }));

        tbodyEl.innerHTML = '';
        currentReportData.forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${escapeHtml(row.status)}</strong></td>
                <td><span class="badge badge-primary">${row.count} Generators</span></td>
                <td>${row.pct}%</td>
            `;
            tbodyEl.appendChild(tr);
        });

        renderReportChart(chartWrap, {
            type: 'doughnut',
            data: {
                labels: currentReportData.map(r => r.status),
                datasets: [{
                    data: currentReportData.map(r => r.count),
                    backgroundColor: ['#10b981', '#f59e0b', '#3b82f6', '#f43f5e']
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { labels: { color: '#9ca3af' } } }
            }
        });
    }
}

function exportReportCSV() {
    if (!currentReportData || currentReportData.length === 0) {
        showToast("No report data available to export", "error");
        return;
    }

    const headers = Object.keys(currentReportData[0]);
    let csv = headers.join(',') + '\n';
    currentReportData.forEach(row => {
        csv += headers.map(h => `"${String(row[h]).replace(/"/g, '""')}"`).join(',') + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `powerplant_oracle_report_${currentReportIndex}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    showToast("Report exported as CSV", "success");
}

// ================= SCHEMA & DDL MANAGEMENT =================

let createTableColumns = [];

async function loadOracleSchemaTables() {
    const tbody = document.getElementById('user-tables-tbody');
    if (!tbody) return;

    if (!odbcState.connected) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted);"><i class="fa-solid fa-lock" style="margin-right:0.4rem;"></i> Connect Oracle database via ODBC to inspect live schema tables.</td></tr>';
        return;
    }

    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Querying Oracle USER_TABLES...</td></tr>';

    try {
        const res = await fetch(apiUrl('/api/odbc/tables'), { credentials: 'same-origin' });
        if (res.status === 401) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--accent-amber);">Session expired. Please reconnect with ODBC.</td></tr>';
            return;
        }

        const data = await res.json();
        if (data.success && Array.isArray(data.tables)) {
            DB.USER_TABLES = data.tables;
            DB.USER_TAB_COLUMNS = data.columns || [];

            // Update dropdown in inspector
            const selectInspect = document.getElementById('selectInspectTable');
            if (selectInspect) {
                const currentVal = selectInspect.value;
                selectInspect.innerHTML = '<option value="">All Tables</option>';
                data.tables.forEach(t => {
                    const opt = document.createElement('option');
                    opt.value = t;
                    opt.textContent = t;
                    selectInspect.appendChild(opt);
                });
                if (currentVal && data.tables.includes(currentVal)) {
                    selectInspect.value = currentVal;
                }
            }

            renderUserTablesList();
            renderCatalogTable(selectInspect ? selectInspect.value : '');
        } else {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--accent-rose);">Error: ${escapeHtml(data.error || 'Failed to query USER_TABLES')}</td></tr>`;
        }
    } catch (e) {
        console.error("Failed to load tables:", e);
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--accent-rose);">Failed to fetch schema: ${escapeHtml(e.message)}</td></tr>`;
    }
}

function renderUserTablesList() {
    const tbody = document.getElementById('user-tables-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const coreTables = ['POWER_PLANT', 'GENERATOR', 'EMPLOYEE', 'GENERATION_RECORD'];
    const allTables = DB.USER_TABLES || [];

    if (allTables.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No tables found in current Oracle schema. Click "Create Table" to add one.</td></tr>';
        return;
    }

    allTables.forEach(t => {
        const isCore = coreTables.includes(t);
        const colCount = (DB.USER_TAB_COLUMNS || []).filter(c => c.TABLE_NAME === t).length;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <strong><i class="fa-solid fa-table" style="color:var(--accent-cyan); margin-right:0.4rem;"></i>${escapeHtml(t)}</strong>
            </td>
            <td>
                <span class="badge ${isCore ? 'badge-primary' : (t === 'MAINTENANCE_LOG' ? 'badge-warning' : 'badge-info')}">
                    ${isCore ? 'Core Assessment Table' : (t === 'MAINTENANCE_LOG' ? 'Assessment DDL Demo' : 'Custom User Table')}
                </span>
            </td>
            <td>
                <code>${colCount ? colCount + ' Columns' : 'Inspect'}</code>
            </td>
            <td>
                <span style="color:var(--accent-emerald); font-size:0.85rem;">
                    <i class="fa-solid fa-circle-check"></i> Verified in Oracle XE
                </span>
            </td>
            <td>
                <div class="row-actions" style="display:flex; gap:0.4rem;">
                    <button class="btn btn-outline btn-xs" title="Inspect Columns in USER_TAB_COLUMNS" onclick="filterCatalogTable('${escapeHtml(t)}')">
                        <i class="fa-solid fa-magnifying-glass"></i> Columns
                    </button>
                    ${!isCore ? `
                        <button class="btn btn-danger btn-xs" title="Drop Table from Oracle" onclick="confirmDropTable('${escapeHtml(t)}')">
                            <i class="fa-solid fa-trash"></i> Drop
                        </button>
                    ` : ''}
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function filterCatalogTable(tableName) {
    const select = document.getElementById('selectInspectTable');
    if (select) select.value = tableName;
    renderCatalogTable(tableName);

    const panel = document.getElementById('panel-schema-inspector');
    if (panel) {
        panel.scrollIntoView({ behavior: 'smooth' });
    }
}

function renderCatalogTable(filterTable = '') {
    const tbody = document.getElementById('catalog-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let cols = DB.USER_TAB_COLUMNS || [];
    if (filterTable) {
        cols = cols.filter(c => c.TABLE_NAME === filterTable.toUpperCase());
    }

    if (cols.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">${filterTable ? `No columns found for table ${escapeHtml(filterTable)}` : 'No columns found in schema catalog.'}</td></tr>`;
        return;
    }

    cols.forEach(c => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${escapeHtml(c.TABLE_NAME)}</strong></td>
            <td><code>${c.COLUMN_ID}</code></td>
            <td><code>${escapeHtml(c.COLUMN_NAME)}</code></td>
            <td><span class="badge badge-info">${escapeHtml(c.DATA_TYPE)}${c.DATA_LENGTH && c.DATA_TYPE.includes('CHAR') ? '(' + c.DATA_LENGTH + ')' : ''}</span></td>
            <td>${c.NULLABLE === 'N' ? '<strong style="color:var(--accent-amber);">NOT NULL</strong>' : 'NULL'}</td>
        `;
        tbody.appendChild(tr);
    });
}

async function inspectSchemaColumns() {
    await loadOracleSchemaTables();
}

// DDL Execution directly via ODBC
async function executeDDLCreateML() {
    if (!odbcState.connected) {
        showToast("Please log in with ODBC first", "error");
        openModal('modal-odbc-login');
        return;
    }
    if (DB.USER_TABLES && DB.USER_TABLES.includes('MAINTENANCE_LOG')) {
        showToast("Table MAINTENANCE_LOG already exists in Oracle schema.", "info");
        await loadOracleSchemaTables();
        return;
    }
    const sql = "CREATE TABLE MAINTENANCE_LOG (LOG_ID NUMBER PRIMARY KEY, PLANT_ID NUMBER REFERENCES POWER_PLANT(PLANT_ID), MAINTENANCE_DATE DATE, DESCRIPTION VARCHAR2(300), COST NUMBER)";
    const success = await executeRawSql(sql, "Table MAINTENANCE_LOG created in Oracle.");
    if (success) {
        DB.SCHEMA_STATE.maintenanceTableCreated = true;
        await syncDatabaseFromOracle(false);
        await loadOracleSchemaTables();
    }
}

async function executeDDLAlterML() {
    if (!odbcState.connected) {
        showToast("Please log in with ODBC first", "error");
        openModal('modal-odbc-login');
        return;
    }
    const hasNotes = (DB.USER_TAB_COLUMNS || []).some(c => c.TABLE_NAME === 'MAINTENANCE_LOG' && c.COLUMN_NAME === 'NOTES');
    if (hasNotes) {
        showToast("Column NOTES already exists on table MAINTENANCE_LOG.", "info");
        return;
    }
    const sql = "ALTER TABLE MAINTENANCE_LOG ADD (NOTES VARCHAR2(200))";
    const success = await executeRawSql(sql, "Table MAINTENANCE_LOG altered. Column NOTES added.");
    if (success) {
        DB.SCHEMA_STATE.maintenanceHasNotes = true;
        await syncDatabaseFromOracle(false);
        await loadOracleSchemaTables();
    }
}

// Interactive Create Table Modal & DDL Generator
function openCreateTableModal() {
    if (!odbcState.connected) {
        showToast("Please log in with ODBC first to create tables in Oracle.", "error");
        openModal('modal-odbc-login');
        return;
    }

    const form = document.getElementById('form-create-table');
    if (form) form.reset();

    const nameInput = document.getElementById('create-table-name');
    if (nameInput) nameInput.value = '';

    const errBox = document.getElementById('create-table-error');
    if (errBox) errBox.style.display = 'none';

    const succBox = document.getElementById('create-table-success');
    if (succBox) succBox.style.display = 'none';

    // Default template: Primary Key and Name column
    createTableColumns = [
        { name: 'ID', type: 'NUMBER', primaryKey: true, notNull: false, unique: false, references: '' },
        { name: 'NAME', type: 'VARCHAR2(100)', primaryKey: false, notNull: true, unique: false, references: '' }
    ];

    renderColumnRows();
    updateDdlPreview();
    openModal('modal-create-table');
}

function addColumnRow() {
    createTableColumns.push({
        name: '',
        type: 'VARCHAR2(100)',
        primaryKey: false,
        notNull: false,
        unique: false,
        references: ''
    });
    renderColumnRows();
    updateDdlPreview();
}

function removeColumnRow(index) {
    if (createTableColumns.length <= 1) {
        showToast("Table must have at least one column.", "warning");
        return;
    }
    createTableColumns.splice(index, 1);
    renderColumnRows();
    updateDdlPreview();
}

function renderColumnRows() {
    const container = document.getElementById('create-table-columns-list');
    if (!container) return;
    container.innerHTML = '';

    const typeOptions = [
        'NUMBER',
        'VARCHAR2(50)',
        'VARCHAR2(100)',
        'VARCHAR2(255)',
        'DATE',
        'TIMESTAMP',
        'CHAR(10)',
        'FLOAT',
        'CLOB'
    ];

    createTableColumns.forEach((col, idx) => {
        const item = document.createElement('div');
        item.className = 'col-builder-item';
        item.innerHTML = `
            <div class="col-builder-top">
                <input type="text" placeholder="Column Name (e.g. ID, NAME)" value="${escapeHtml(col.name)}" 
                    oninput="createTableColumns[${idx}].name = this.value.toUpperCase(); updateDdlPreview();" maxlength="30" required>
                <select onchange="createTableColumns[${idx}].type = this.value; updateDdlPreview();">
                    ${typeOptions.map(t => `<option value="${t}" ${col.type === t ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
                <button type="button" class="btn-remove-col" title="Remove Column" onclick="removeColumnRow(${idx})">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
            <div class="col-builder-bottom">
                <div class="col-checkbox-group">
                    <label>
                        <input type="checkbox" ${col.primaryKey ? 'checked' : ''} 
                            onchange="onPkChange(${idx}, this.checked)">
                        PK
                    </label>
                    <label>
                        <input type="checkbox" ${col.notNull ? 'checked' : ''} ${col.primaryKey ? 'disabled' : ''}
                            onchange="createTableColumns[${idx}].notNull = this.checked; updateDdlPreview();">
                        NOT NULL
                    </label>
                    <label>
                        <input type="checkbox" ${col.unique ? 'checked' : ''} ${col.primaryKey ? 'disabled' : ''}
                            onchange="createTableColumns[${idx}].unique = this.checked; updateDdlPreview();">
                        UNIQUE
                    </label>
                </div>
                <div>
                    <input type="text" class="col-ref-input" placeholder="FK Ref (e.g. POWER_PLANT(PLANT_ID))" value="${escapeHtml(col.references || '')}"
                        oninput="createTableColumns[${idx}].references = this.value.toUpperCase(); updateDdlPreview();">
                </div>
            </div>
        `;
        container.appendChild(item);
    });
}

function onPkChange(idx, isChecked) {
    if (isChecked) {
        createTableColumns.forEach((c, i) => {
            if (i !== idx) c.primaryKey = false;
        });
        createTableColumns[idx].primaryKey = true;
        createTableColumns[idx].notNull = false;
        createTableColumns[idx].unique = false;
    } else {
        createTableColumns[idx].primaryKey = false;
    }
    renderColumnRows();
    updateDdlPreview();
}

function updateDdlPreview() {
    const nameInput = document.getElementById('create-table-name');
    const previewEl = document.getElementById('create-table-ddl-preview');
    if (!previewEl) return;

    const tableName = (nameInput ? nameInput.value.trim().toUpperCase() : '') || 'TABLE_NAME';

    const colDefs = createTableColumns.map(col => {
        const cName = col.name ? col.name.trim().toUpperCase() : 'COLUMN';
        let def = `${cName} ${col.type}`;
        if (col.primaryKey) def += ' PRIMARY KEY';
        else {
            if (col.notNull) def += ' NOT NULL';
            if (col.unique) def += ' UNIQUE';
        }
        if (col.references) {
            def += ` REFERENCES ${col.references.trim().toUpperCase()}`;
        }
        return `    ${def}`;
    });

    const ddl = `CREATE TABLE ${tableName} (\n${colDefs.join(',\n')}\n);`;
    previewEl.textContent = ddl;
}

async function handleCreateTable(event) {
    if (event) event.preventDefault();

    const nameInput = document.getElementById('create-table-name');
    const tableName = (nameInput ? nameInput.value.trim().toUpperCase() : '');
    const errBox = document.getElementById('create-table-error');
    const errMsg = document.getElementById('create-table-error-msg');
    const succBox = document.getElementById('create-table-success');
    const succMsg = document.getElementById('create-table-success-msg');
    const submitBtn = document.getElementById('btnSubmitCreateTable');

    if (!tableName) {
        if (errBox) errBox.style.display = 'flex';
        if (errMsg) errMsg.textContent = 'Table name is required.';
        return;
    }

    if (!/^[A-Z][A-Z0-9_$]{0,29}$/.test(tableName)) {
        if (errBox) errBox.style.display = 'flex';
        if (errMsg) errMsg.textContent = `Invalid table name '${tableName}'. Must be 1-30 characters, begin with a letter, and contain only letters, numbers, and underscores.`;
        return;
    }

    for (let i = 0; i < createTableColumns.length; i++) {
        const c = createTableColumns[i];
        if (!c.name || !c.name.trim()) {
            if (errBox) errBox.style.display = 'flex';
            if (errMsg) errMsg.textContent = `Column #${i + 1} is missing a name.`;
            return;
        }
        if (!/^[A-Z][A-Z0-9_$]{0,29}$/.test(c.name.trim().toUpperCase())) {
            if (errBox) errBox.style.display = 'flex';
            if (errMsg) errMsg.textContent = `Invalid column name '${c.name}'. Must be 1-30 characters and start with a letter.`;
            return;
        }
    }

    if (errBox) errBox.style.display = 'none';
    if (succBox) succBox.style.display = 'none';

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Executing DDL in Oracle...';
    }

    try {
        const csrfToken = await ensureCsrfToken();
        const res = await fetch(apiUrl('/api/odbc/create-table'), {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({
                tableName,
                columns: createTableColumns
            })
        });

        const data = await res.json();

        if (res.ok && data.success) {
            if (succBox) succBox.style.display = 'flex';
            if (succMsg) succMsg.textContent = data.message || `Table ${tableName} successfully created in Oracle!`;
            showToast(`Table ${tableName} created and verified in Oracle!`, "success");

            await loadOracleSchemaTables();

            setTimeout(() => {
                closeModal('modal-create-table');
                if (succBox) succBox.style.display = 'none';
            }, 1200);
        } else {
            if (errBox) errBox.style.display = 'flex';
            if (errMsg) errMsg.innerHTML = `<strong>Oracle DDL Error:</strong><br>${escapeHtml(data.error || 'Failed to create table.')}`;
            showToast("Failed to create table in Oracle", "error");
        }
    } catch (e) {
        if (errBox) errBox.style.display = 'flex';
        if (errMsg) errMsg.textContent = `Network / Execution Error: ${e.message}`;
        showToast("Error executing DDL", "error");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fa-solid fa-play"></i> Execute CREATE TABLE';
        }
    }
}

function confirmDropTable(tableName) {
    const msg = document.getElementById('delete-confirm-message');
    const warnBox = document.getElementById('delete-cascade-warning');
    if (msg) {
        msg.innerHTML = `Are you sure you want to drop table <strong>${escapeHtml(tableName)}</strong> from Oracle?<br><br>` +
            `<small style="color:var(--accent-amber);"><i class="fa-solid fa-triangle-exclamation"></i> This will execute <code>DROP TABLE ${escapeHtml(tableName)} CASCADE CONSTRAINTS</code> in Oracle XE.</small>`;
    }
    if (warnBox) warnBox.style.display = 'flex';

    pendingDeleteAction = async () => {
        try {
            const csrfToken = await ensureCsrfToken();
            const res = await fetch(apiUrl('/api/odbc/drop-table'), {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken
                },
                body: JSON.stringify({ tableName })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                showToast(`Table ${tableName} dropped from Oracle.`, "success");
                await loadOracleSchemaTables();
                closeModal('modal-confirm-delete');
            } else {
                showToast(data.error || "Failed to drop table", "error");
            }
        } catch (e) {
            showToast(e.message, "error");
        }
    };

    const confirmBtn = document.getElementById('btnConfirmDeleteAction');
    if (confirmBtn) {
        confirmBtn.onclick = pendingDeleteAction;
    }
    openModal('modal-confirm-delete');
}


// SQL Terminal Execution
function loadSQLPreset(presetKey) {
    const editor = document.getElementById('sqlInput');
    if (!editor) return;

    switch (presetKey) {
        case 'all_plants':
            editor.value = "SELECT * FROM POWER_PLANT ORDER BY PLANT_ID;";
            break;
        case 'plant_generation_join':
            editor.value = "SELECT p.PLANT_NAME, p.CAPACITY_MW, NVL(SUM(g.UNITS_GENERATED), 0) AS TOTAL_UNITS, COUNT(g.RECORD_ID) AS RECORD_COUNT\nFROM POWER_PLANT p\nLEFT JOIN GENERATION_RECORD g ON p.PLANT_ID = g.PLANT_ID\nGROUP BY p.PLANT_NAME, p.CAPACITY_MW\nORDER BY TOTAL_UNITS DESC;";
            break;
        case 'capacity_order':
            editor.value = "SELECT PLANT_ID, PLANT_NAME, LOCATION, CAPACITY_MW\nFROM POWER_PLANT\nORDER BY CAPACITY_MW DESC;";
            break;
        case 'employee_count':
            editor.value = "SELECT p.PLANT_NAME, COUNT(e.EMPLOYEE_ID) AS EMPLOYEE_COUNT\nFROM POWER_PLANT p\nLEFT JOIN EMPLOYEE e ON p.PLANT_ID = e.PLANT_ID\nGROUP BY p.PLANT_NAME\nORDER BY p.PLANT_NAME;";
            break;
        case 'active_generators':
            editor.value = "SELECT g.GENERATOR_ID, g.GENERATOR_NAME, p.PLANT_NAME, g.STATUS\nFROM GENERATOR g\nJOIN POWER_PLANT p ON g.PLANT_ID = p.PLANT_ID\nWHERE UPPER(g.STATUS) = 'ACTIVE';";
            break;
        case 'user_tab_columns':
            editor.value = "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE\nFROM USER_TAB_COLUMNS\nWHERE TABLE_NAME IN ('POWER_PLANT', 'GENERATOR', 'EMPLOYEE', 'GENERATION_RECORD', 'MAINTENANCE_LOG')\nORDER BY TABLE_NAME, COLUMN_ID;";
            break;
    }
    runCustomSQL();
}

function clearSQLEditor() {
    document.getElementById('sqlInput').value = '';
    document.getElementById('sql-execution-status').textContent = 'Editor cleared';
}

async function runCustomSQL() {
    const rawSql = document.getElementById('sqlInput').value.trim();
    if (!rawSql) {
        showToast("Please enter a SQL query to execute", "error");
        return;
    }

    const cleanSql = rawSql.replace(/;+$/, '').trim();
    const thead = document.getElementById('sql-results-thead');
    const tbody = document.getElementById('sql-results-tbody');
    const countBadge = document.getElementById('sql-row-count');
    const statusEl = document.getElementById('sql-execution-status');

    thead.innerHTML = '<tr><th>Executing on Oracle Database...</th></tr>';
    tbody.innerHTML = '<tr><td><i class="fa-solid fa-spinner fa-spin"></i> Running query via ODBC...</td></tr>';
    statusEl.textContent = 'Executing...';

    const startTime = performance.now();

    if (odbcState.connected) {
        try {
            const csrfToken = await ensureCsrfToken();
            const res = await fetch(apiUrl('/api/odbc/query'), {
                credentials: 'same-origin',
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken
                },
                body: JSON.stringify({ sql: cleanSql })
            });
            const data = await res.json();
            const elapsed = (performance.now() - startTime).toFixed(2);

            if (data.success) {
                const cols = data.columns || [];
                const rows = data.rows || [];

                thead.innerHTML = '<tr>' + cols.map(c => `<th>${escapeHtml(c)}</th>`).join('') + '</tr>';
                if (rows.length === 0) {
                    tbody.innerHTML = `<tr><td colspan="${cols.length || 1}" style="text-align:center; color:var(--text-dim);">No rows returned (or statement executed with 0 rows affected).</td></tr>`;
                } else {
                    tbody.innerHTML = rows.map(r => '<tr>' + cols.map(c => `<td>${escapeHtml(String(r[c] !== undefined && r[c] !== null ? r[c] : 'NULL'))}</td>`).join('') + '</tr>').join('');
                }

                countBadge.textContent = `${rows.length} row(s) returned (${elapsed} ms)`;
                statusEl.textContent = `Executed in ${elapsed} ms on Oracle`;
                showToast("Oracle SQL Query executed successfully", "success");

                // Auto refresh state if DML/DDL executed
                if (/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(cleanSql)) {
                    syncDatabaseFromOracle(false);
                }
            } else {
                thead.innerHTML = '<tr><th>Oracle ODBC Error</th></tr>';
                tbody.innerHTML = `<tr><td style="color:var(--accent-rose); font-family:var(--font-mono);">${escapeHtml(data.error)}</td></tr>`;
                countBadge.textContent = 'Oracle Error';
                statusEl.textContent = 'Query execution failed on Oracle';
                showToast(data.error, "error");
            }
        } catch (e) {
            thead.innerHTML = '<tr><th>Error</th></tr>';
            tbody.innerHTML = `<tr><td style="color:var(--accent-rose); font-family:var(--font-mono);">${escapeHtml(e.message)}</td></tr>`;
            showToast(e.message, "error");
        }
    } else {
        // Local mode warning
        thead.innerHTML = '<tr><th>Not Connected via ODBC</th></tr>';
        tbody.innerHTML = `<tr><td style="color:var(--accent-amber); font-family:var(--font-mono);">Please connect via ODBC using the "ODBC Login" button to execute live SQL against your Oracle database.</td></tr>`;
        showToast("Please log in with ODBC first", "error");
        openModal('modal-odbc-login');
    }
}

async function executeRawSql(sql, successMsg = "Statement executed") {
    if (!odbcState.connected) {
        showToast("Please log in with ODBC first", "error");
        openModal('modal-odbc-login');
        return;
    }
    try {
        const csrfToken = await ensureCsrfToken();
        const res = await fetch(apiUrl('/api/odbc/query'), {
                credentials: 'same-origin',
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({ sql })
        });
        const data = await res.json();
        if (data.success) {
            showToast(successMsg, "success");
            return true;
        } else {
            showToast(data.error, "error");
            return false;
        }
    } catch (e) {
        showToast(e.message, "error");
        return false;
    }
}

function openAddPlant() {
    const form = document.getElementById('form-plant');
    if (form) form.reset();
    const mode = document.getElementById('plant-mode');
    if (mode) mode.value = 'add';
    const title = document.getElementById('modal-plant-title');
    if (title) title.innerHTML = '<i class="fa-solid fa-industry"></i> Add Power Plant';
    const idInput = document.getElementById('plant-id');
    if (idInput) {
        idInput.readOnly = false;
        const maxId = DB.POWER_PLANT.reduce((max, p) => Math.max(max, Number(p.PLANT_ID || 0)), 0);
        idInput.value = maxId + 1;
    }
    openModal('modal-add-plant');
}

// Plant CRUD
async function savePlant(event) {
    event.preventDefault();
    const mode = document.getElementById('plant-mode').value;
    const id = Number(document.getElementById('plant-id').value);
    const name = document.getElementById('plant-name').value.trim();
    const loc = document.getElementById('plant-location').value.trim();
    const cap = Number(document.getElementById('plant-capacity').value);

    let sql = "";
    if (mode === 'add') {
        sql = `INSERT INTO POWER_PLANT (PLANT_ID, PLANT_NAME, LOCATION, CAPACITY_MW) VALUES (${id}, '${name.replace(/'/g, "''")}', '${loc.replace(/'/g, "''")}', ${cap})`;
    } else {
        sql = `UPDATE POWER_PLANT SET PLANT_NAME = '${name.replace(/'/g, "''")}', LOCATION = '${loc.replace(/'/g, "''")}', CAPACITY_MW = ${cap} WHERE PLANT_ID = ${id}`;
    }

    const success = await executeRawSql(sql, `Power Plant "${name}" ${mode === 'add' ? 'created' : 'updated'} in Oracle.`);
    if (success) {
        await syncDatabaseFromOracle(false);
        closeModal('modal-add-plant');
        document.getElementById('form-plant').reset();
    }
}

function openEditPlant(id) {
    const p = DB.POWER_PLANT.find(x => Number(x.PLANT_ID) === Number(id));
    if (!p) return;

    document.getElementById('plant-mode').value = 'edit';
    document.getElementById('modal-plant-title').innerHTML = '<i class="fa-solid fa-pen"></i> Edit Power Plant';
    const idInput = document.getElementById('plant-id');
    idInput.value = p.PLANT_ID;
    idInput.readOnly = true;

    document.getElementById('plant-name').value = p.PLANT_NAME;
    document.getElementById('plant-location').value = p.LOCATION;
    document.getElementById('plant-capacity').value = p.CAPACITY_MW;

    openModal('modal-add-plant');
}

function confirmDeletePlant(plantId) {
    const p = DB.POWER_PLANT.find(x => Number(x.PLANT_ID) === Number(plantId));
    if (!p) return;

    const childGen = DB.GENERATOR.filter(g => Number(g.PLANT_ID) === Number(plantId)).length;
    const childEmp = DB.EMPLOYEE.filter(e => Number(e.PLANT_ID) === Number(plantId)).length;
    const childRec = DB.GENERATION_RECORD.filter(r => Number(r.PLANT_ID) === Number(plantId)).length;

    const hasChildren = (childGen + childEmp + childRec) > 0;
    const warnBox = document.getElementById('delete-cascade-warning');
    const msg = document.getElementById('delete-confirm-message');

    msg.textContent = `Are you sure you want to delete "${p.PLANT_NAME}" (ID: ${p.PLANT_ID}) from Oracle?`;
    if (warnBox) warnBox.style.display = hasChildren ? 'flex' : 'none';

    pendingDeleteAction = async () => {
        // Cascade delete child foreign keys first in Oracle
        if (childGen) await executeRawSql(`DELETE FROM GENERATOR WHERE PLANT_ID = ${plantId}`);
        if (childEmp) await executeRawSql(`DELETE FROM EMPLOYEE WHERE PLANT_ID = ${plantId}`);
        if (childRec) await executeRawSql(`DELETE FROM GENERATION_RECORD WHERE PLANT_ID = ${plantId}`);
        if (DB.SCHEMA_STATE.maintenanceTableCreated) {
            await executeRawSql(`DELETE FROM MAINTENANCE_LOG WHERE PLANT_ID = ${plantId}`);
        }
        await executeRawSql(`DELETE FROM POWER_PLANT WHERE PLANT_ID = ${plantId}`, `Power Plant #${plantId} deleted from Oracle.`);

        await syncDatabaseFromOracle(false);
        closeModal('modal-confirm-delete');
    };

    document.getElementById('btnConfirmDeleteAction').onclick = pendingDeleteAction;
    openModal('modal-confirm-delete');
}

function viewPlantDetails(plantId) {
    const p = DB.POWER_PLANT.find(x => Number(x.PLANT_ID) === Number(plantId));
    if (!p) return;

    const gens = DB.GENERATOR.filter(g => Number(g.PLANT_ID) === Number(plantId));
    const emps = DB.EMPLOYEE.filter(e => Number(e.PLANT_ID) === Number(plantId));
    const recs = DB.GENERATION_RECORD.filter(r => Number(r.PLANT_ID) === Number(plantId));
    const totalGen = recs.reduce((s, r) => s + Number(r.UNITS_GENERATED || 0), 0);

    const content = document.getElementById('view-plant-content');
    content.innerHTML = `
        <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:1rem; margin-bottom:1.5rem;">
            <div class="kpi-card" style="padding:1rem;">
                <span class="kpi-title">Capacity</span>
                <strong style="font-size:1.4rem; color:var(--accent-amber);">${p.CAPACITY_MW} MW</strong>
            </div>
            <div class="kpi-card" style="padding:1rem;">
                <span class="kpi-title">Generators</span>
                <strong style="font-size:1.4rem; color:var(--accent-cyan);">${gens.length} Units</strong>
            </div>
            <div class="kpi-card" style="padding:1rem;">
                <span class="kpi-title">Total Output</span>
                <strong style="font-size:1.4rem; color:var(--accent-emerald);">${totalGen.toLocaleString()} MWh</strong>
            </div>
        </div>

        <h5 style="margin-bottom:0.6rem;"><i class="fa-solid fa-gears"></i> Installed Generators</h5>
        <ul style="margin-bottom:1.25rem; padding-left:1.2rem; color:var(--text-muted);">
            ${gens.length ? gens.map(g => `<li><strong>${g.GENERATOR_NAME}</strong> (ID: ${g.GENERATOR_ID}) - Status: <span class="badge badge-success">${g.STATUS}</span></li>`).join('') : '<li>No generators assigned.</li>'}
        </ul>

        <h5 style="margin-bottom:0.6rem;"><i class="fa-solid fa-users"></i> Staff on Duty</h5>
        <ul style="padding-left:1.2rem; color:var(--text-muted);">
            ${emps.length ? emps.map(e => `<li><strong>${e.EMPLOYEE_NAME}</strong> - ${e.ROLE}</li>`).join('') : '<li>No employees assigned.</li>'}
        </ul>
    `;
    openModal('modal-view-plant');
}

function openAddGenerator() {
    const form = document.getElementById('form-generator');
    if (form) form.reset();
    const mode = document.getElementById('generator-mode');
    if (mode) mode.value = 'add';
    const title = document.getElementById('modal-generator-title');
    if (title) title.innerHTML = '<i class="fa-solid fa-gears"></i> Add Generator';
    const idInput = document.getElementById('generator-id');
    if (idInput) {
        idInput.readOnly = false;
        const maxId = DB.GENERATOR.reduce((max, g) => Math.max(max, Number(g.GENERATOR_ID || 0)), 0);
        idInput.value = maxId ? maxId + 1 : 101;
    }
    populatePlantDropdowns();
    openModal('modal-add-generator');
}

// Generator CRUD
async function saveGenerator(event) {
    event.preventDefault();
    const mode = document.getElementById('generator-mode').value;
    const id = Number(document.getElementById('generator-id').value);
    const plantId = Number(document.getElementById('generator-plant-id').value);
    const name = document.getElementById('generator-name').value.trim();
    const status = document.getElementById('generator-status').value;

    let sql = "";
    if (mode === 'add') {
        sql = `INSERT INTO GENERATOR (GENERATOR_ID, PLANT_ID, GENERATOR_NAME, STATUS) VALUES (${id}, ${plantId}, '${name.replace(/'/g, "''")}', '${status.replace(/'/g, "''")}')`;
    } else {
        sql = `UPDATE GENERATOR SET PLANT_ID = ${plantId}, GENERATOR_NAME = '${name.replace(/'/g, "''")}', STATUS = '${status.replace(/'/g, "''")}' WHERE GENERATOR_ID = ${id}`;
    }

    const success = await executeRawSql(sql, `Generator "${name}" ${mode === 'add' ? 'created' : 'updated'} in Oracle.`);
    if (success) {
        await syncDatabaseFromOracle(false);
        closeModal('modal-add-generator');
        document.getElementById('form-generator').reset();
    }
}

function openEditGenerator(id) {
    const g = DB.GENERATOR.find(x => Number(x.GENERATOR_ID) === Number(id));
    if (!g) return;

    document.getElementById('generator-mode').value = 'edit';
    document.getElementById('modal-generator-title').innerHTML = '<i class="fa-solid fa-pen"></i> Edit Generator';
    const idInput = document.getElementById('generator-id');
    idInput.value = g.GENERATOR_ID;
    idInput.readOnly = true;

    populatePlantDropdowns();
    document.getElementById('generator-plant-id').value = g.PLANT_ID;
    document.getElementById('generator-name').value = g.GENERATOR_NAME;
    document.getElementById('generator-status').value = g.STATUS;

    openModal('modal-add-generator');
}

function deleteGenerator(id) {
    const g = DB.GENERATOR.find(x => Number(x.GENERATOR_ID) === Number(id));
    const name = g ? g.GENERATOR_NAME : `#${id}`;
    const warnBox = document.getElementById('delete-cascade-warning');
    const msg = document.getElementById('delete-confirm-message');
    msg.textContent = `Are you sure you want to delete generator "${name}" (ID: ${id}) from Oracle?`;
    if (warnBox) warnBox.style.display = 'none';

    pendingDeleteAction = async () => {
        const ok = await executeRawSql(`DELETE FROM GENERATOR WHERE GENERATOR_ID = ${id}`, `Generator #${id} deleted from Oracle.`);
        if (ok) {
            await syncDatabaseFromOracle(false);
            closeModal('modal-confirm-delete');
        }
    };
    document.getElementById('btnConfirmDeleteAction').onclick = pendingDeleteAction;
    openModal('modal-confirm-delete');
}

function openAddEmployee() {
    const form = document.getElementById('form-employee');
    if (form) form.reset();
    const mode = document.getElementById('employee-mode');
    if (mode) mode.value = 'add';
    const title = document.getElementById('modal-employee-title');
    if (title) title.innerHTML = '<i class="fa-solid fa-user-plus"></i> Register Employee';
    const idInput = document.getElementById('employee-id');
    if (idInput) {
        idInput.readOnly = false;
        const maxId = DB.EMPLOYEE.reduce((max, e) => Math.max(max, Number(e.EMPLOYEE_ID || 0)), 0);
        idInput.value = maxId ? maxId + 1 : 201;
    }
    populatePlantDropdowns();
    openModal('modal-add-employee');
}

// Employee CRUD
async function saveEmployee(event) {
    event.preventDefault();
    const mode = document.getElementById('employee-mode').value;
    const id = Number(document.getElementById('employee-id').value);
    const plantId = Number(document.getElementById('employee-plant-id').value);
    const name = document.getElementById('employee-name').value.trim();
    const role = document.getElementById('employee-role').value.trim();

    let sql = "";
    if (mode === 'add') {
        sql = `INSERT INTO EMPLOYEE (EMPLOYEE_ID, EMPLOYEE_NAME, ROLE, PLANT_ID) VALUES (${id}, '${name.replace(/'/g, "''")}', '${role.replace(/'/g, "''")}', ${plantId})`;
    } else {
        sql = `UPDATE EMPLOYEE SET EMPLOYEE_NAME = '${name.replace(/'/g, "''")}', ROLE = '${role.replace(/'/g, "''")}', PLANT_ID = ${plantId} WHERE EMPLOYEE_ID = ${id}`;
    }

    const success = await executeRawSql(sql, `Employee "${name}" ${mode === 'add' ? 'registered' : 'updated'} in Oracle.`);
    if (success) {
        await syncDatabaseFromOracle(false);
        closeModal('modal-add-employee');
        document.getElementById('form-employee').reset();
    }
}

function openEditEmployee(id) {
    const e = DB.EMPLOYEE.find(x => Number(x.EMPLOYEE_ID) === Number(id));
    if (!e) return;

    document.getElementById('employee-mode').value = 'edit';
    document.getElementById('modal-employee-title').innerHTML = '<i class="fa-solid fa-pen"></i> Edit Employee';
    const idInput = document.getElementById('employee-id');
    idInput.value = e.EMPLOYEE_ID;
    idInput.readOnly = true;

    populatePlantDropdowns();
    document.getElementById('employee-name').value = e.EMPLOYEE_NAME;
    document.getElementById('employee-role').value = e.ROLE;
    document.getElementById('employee-plant-id').value = e.PLANT_ID;

    openModal('modal-add-employee');
}

function deleteEmployee(id) {
    const e = DB.EMPLOYEE.find(x => Number(x.EMPLOYEE_ID) === Number(id));
    const name = e ? e.EMPLOYEE_NAME : `#${id}`;
    const warnBox = document.getElementById('delete-cascade-warning');
    const msg = document.getElementById('delete-confirm-message');
    msg.textContent = `Are you sure you want to remove employee "${name}" (ID: ${id}) from Oracle?`;
    if (warnBox) warnBox.style.display = 'none';

    pendingDeleteAction = async () => {
        const ok = await executeRawSql(`DELETE FROM EMPLOYEE WHERE EMPLOYEE_ID = ${id}`, `Employee #${id} removed from Oracle.`);
        if (ok) {
            await syncDatabaseFromOracle(false);
            closeModal('modal-confirm-delete');
        }
    };
    document.getElementById('btnConfirmDeleteAction').onclick = pendingDeleteAction;
    openModal('modal-confirm-delete');
}

function openAddRecord() {
    const form = document.getElementById('form-record');
    if (form) form.reset();
    const mode = document.getElementById('record-mode');
    if (mode) mode.value = 'add';
    const title = document.getElementById('modal-record-title');
    if (title) title.innerHTML = '<i class="fa-solid fa-bolt"></i> Log Generation Record';
    const idInput = document.getElementById('record-id');
    if (idInput) {
        idInput.readOnly = false;
        const maxId = DB.GENERATION_RECORD.reduce((max, r) => Math.max(max, Number(r.RECORD_ID || 0)), 0);
        idInput.value = maxId ? maxId + 1 : 301;
    }
    const dateInput = document.getElementById('record-date');
    if (dateInput) {
        dateInput.value = new Date().toISOString().split('T')[0];
    }
    populatePlantDropdowns();
    openModal('modal-add-record');
}

// Generation Record CRUD
async function saveRecord(event) {
    event.preventDefault();
    const mode = document.getElementById('record-mode').value;
    const id = Number(document.getElementById('record-id').value);
    const plantId = Number(document.getElementById('record-plant-id').value);
    const date = document.getElementById('record-date').value;
    const units = Number(document.getElementById('record-units').value);

    let sql = "";
    if (mode === 'add') {
        sql = `INSERT INTO GENERATION_RECORD (RECORD_ID, PLANT_ID, GENERATION_DATE, UNITS_GENERATED) VALUES (${id}, ${plantId}, TO_DATE('${date}', 'YYYY-MM-DD'), ${units})`;
    } else {
        sql = `UPDATE GENERATION_RECORD SET PLANT_ID = ${plantId}, GENERATION_DATE = TO_DATE('${date}', 'YYYY-MM-DD'), UNITS_GENERATED = ${units} WHERE RECORD_ID = ${id}`;
    }

    const success = await executeRawSql(sql, `Generation output logged in Oracle.`);
    if (success) {
        await syncDatabaseFromOracle(false);
        closeModal('modal-add-record');
        document.getElementById('form-record').reset();
    }
}

function openEditRecord(id) {
    const r = DB.GENERATION_RECORD.find(x => Number(x.RECORD_ID) === Number(id));
    if (!r) return;

    document.getElementById('record-mode').value = 'edit';
    document.getElementById('modal-record-title').innerHTML = '<i class="fa-solid fa-pen"></i> Edit Generation Record';
    const idInput = document.getElementById('record-id');
    idInput.value = r.RECORD_ID;
    idInput.readOnly = true;

    populatePlantDropdowns();
    document.getElementById('record-plant-id').value = r.PLANT_ID;
    document.getElementById('record-date').value = r.GENERATION_DATE;
    document.getElementById('record-units').value = r.UNITS_GENERATED;

    openModal('modal-add-record');
}

function deleteRecord(id) {
    const r = DB.GENERATION_RECORD.find(x => Number(x.RECORD_ID) === Number(id));
    const label = r ? `${r.UNITS_GENERATED} MWh on ${r.GENERATION_DATE}` : `#${id}`;
    const warnBox = document.getElementById('delete-cascade-warning');
    const msg = document.getElementById('delete-confirm-message');
    msg.textContent = `Are you sure you want to delete generation record #${id} (${label}) from Oracle?`;
    if (warnBox) warnBox.style.display = 'none';

    pendingDeleteAction = async () => {
        const ok = await executeRawSql(`DELETE FROM GENERATION_RECORD WHERE RECORD_ID = ${id}`, `Generation record #${id} deleted.`);
        if (ok) {
            await syncDatabaseFromOracle(false);
            closeModal('modal-confirm-delete');
        }
    };
    document.getElementById('btnConfirmDeleteAction').onclick = pendingDeleteAction;
    openModal('modal-confirm-delete');
}

function openAddMaintenance() {
    const form = document.getElementById('form-maintenance');
    if (form) form.reset();
    const mode = document.getElementById('maintenance-mode');
    if (mode) mode.value = 'add';
    const title = document.getElementById('modal-maintenance-title');
    if (title) title.innerHTML = '<i class="fa-solid fa-wrench"></i> Log Maintenance Work';
    const idInput = document.getElementById('maint-id');
    if (idInput) {
        idInput.readOnly = false;
        const maxId = DB.MAINTENANCE_LOG.reduce((max, m) => Math.max(max, Number(m.LOG_ID || 0)), 0);
        idInput.value = maxId ? maxId + 1 : 401;
    }
    const dateInput = document.getElementById('maint-date');
    if (dateInput) {
        dateInput.value = new Date().toISOString().split('T')[0];
    }
    populatePlantDropdowns();
    openModal('modal-add-maintenance');
}

// Maintenance Log CRUD
async function saveMaintenance(event) {
    event.preventDefault();
    const mode = document.getElementById('maintenance-mode').value;
    const id = Number(document.getElementById('maint-id').value);
    const plantId = Number(document.getElementById('maint-plant-id').value);
    const date = document.getElementById('maint-date').value;
    const desc = document.getElementById('maint-desc').value.trim();
    const cost = Number(document.getElementById('maint-cost').value);
    const notes = document.getElementById('maint-notes').value.trim();

    let sql = "";
    if (mode === 'add') {
        if (DB.SCHEMA_STATE.maintenanceHasNotes) {
            sql = `INSERT INTO MAINTENANCE_LOG (LOG_ID, PLANT_ID, MAINTENANCE_DATE, DESCRIPTION, COST, NOTES) VALUES (${id}, ${plantId}, TO_DATE('${date}', 'YYYY-MM-DD'), '${desc.replace(/'/g, "''")}', ${cost}, '${notes.replace(/'/g, "''")}')`;
        } else {
            sql = `INSERT INTO MAINTENANCE_LOG (LOG_ID, PLANT_ID, MAINTENANCE_DATE, DESCRIPTION, COST) VALUES (${id}, ${plantId}, TO_DATE('${date}', 'YYYY-MM-DD'), '${desc.replace(/'/g, "''")}', ${cost})`;
        }
    } else {
        if (DB.SCHEMA_STATE.maintenanceHasNotes) {
            sql = `UPDATE MAINTENANCE_LOG SET PLANT_ID = ${plantId}, MAINTENANCE_DATE = TO_DATE('${date}', 'YYYY-MM-DD'), DESCRIPTION = '${desc.replace(/'/g, "''")}', COST = ${cost}, NOTES = '${notes.replace(/'/g, "''")}' WHERE LOG_ID = ${id}`;
        } else {
            sql = `UPDATE MAINTENANCE_LOG SET PLANT_ID = ${plantId}, MAINTENANCE_DATE = TO_DATE('${date}', 'YYYY-MM-DD'), DESCRIPTION = '${desc.replace(/'/g, "''")}', COST = ${cost} WHERE LOG_ID = ${id}`;
        }
    }

    const success = await executeRawSql(sql, `Maintenance log #${id} saved in Oracle.`);
    if (success) {
        await syncDatabaseFromOracle(false);
        closeModal('modal-add-maintenance');
        document.getElementById('form-maintenance').reset();
    }
}

function openEditMaintenance(id) {
    const m = DB.MAINTENANCE_LOG.find(x => Number(x.LOG_ID) === Number(id));
    if (!m) return;

    document.getElementById('maintenance-mode').value = 'edit';
    document.getElementById('modal-maintenance-title').innerHTML = '<i class="fa-solid fa-pen"></i> Edit Maintenance Log';
    const idInput = document.getElementById('maint-id');
    idInput.value = m.LOG_ID;
    idInput.readOnly = true;

    populatePlantDropdowns();
    document.getElementById('maint-plant-id').value = m.PLANT_ID;
    document.getElementById('maint-date').value = m.MAINTENANCE_DATE;
    document.getElementById('maint-desc').value = m.DESCRIPTION;
    document.getElementById('maint-cost').value = m.COST;
    document.getElementById('maint-notes').value = m.NOTES || '';

    openModal('modal-add-maintenance');
}

function deleteMaintenance(id) {
    const m = DB.MAINTENANCE_LOG.find(x => Number(x.LOG_ID) === Number(id));
    const label = m ? `${m.DESCRIPTION} ($${m.COST})` : `#${id}`;
    const warnBox = document.getElementById('delete-cascade-warning');
    const msg = document.getElementById('delete-confirm-message');
    msg.textContent = `Are you sure you want to delete maintenance entry #${id} (${label}) from Oracle?`;
    if (warnBox) warnBox.style.display = 'none';

    pendingDeleteAction = async () => {
        const ok = await executeRawSql(`DELETE FROM MAINTENANCE_LOG WHERE LOG_ID = ${id}`, `Maintenance log #${id} deleted.`);
        if (ok) {
            await syncDatabaseFromOracle(false);
            closeModal('modal-confirm-delete');
        }
    };
    document.getElementById('btnConfirmDeleteAction').onclick = pendingDeleteAction;
    openModal('modal-confirm-delete');
}

// Global search and filters
function initGlobalSearch() {
    const globalInput = document.getElementById('globalSearchInput');
    if (globalInput) {
        globalInput.addEventListener('input', (e) => {
            const val = e.target.value;
            renderPlantsTable(val);
            renderGeneratorsTable('', val);
            renderEmployeesTable('', val);
            renderRecordsTable('', val);
        });
    }

    document.getElementById('searchPlants')?.addEventListener('input', (e) => renderPlantsTable(e.target.value));
    document.getElementById('searchGenerators')?.addEventListener('input', (e) => renderGeneratorsTable(document.getElementById('filterGeneratorStatus').value, e.target.value));
    document.getElementById('searchEmployees')?.addEventListener('input', (e) => renderEmployeesTable(document.getElementById('filterEmployeeRole').value, e.target.value));
    document.getElementById('searchRecords')?.addEventListener('input', (e) => renderRecordsTable(document.getElementById('filterRecordPlant').value, e.target.value));
}

function filterGenerators() {
    renderGeneratorsTable(document.getElementById('filterGeneratorStatus').value, document.getElementById('searchGenerators').value);
}

function filterEmployees() {
    renderEmployeesTable(document.getElementById('filterEmployeeRole').value, document.getElementById('searchEmployees').value);
}

function filterRecords() {
    renderRecordsTable(document.getElementById('filterRecordPlant').value, document.getElementById('searchRecords').value);
}

function sortTable(tableKey, column) {
    if (currentSort.table === tableKey && currentSort.column === column) {
        currentSort.asc = !currentSort.asc;
    } else {
        currentSort.table = tableKey;
        currentSort.column = column;
        currentSort.asc = true;
    }

    if (tableKey === 'plants') renderPlantsTable();
    else if (tableKey === 'generators') renderGeneratorsTable();
    else if (tableKey === 'employees') renderEmployeesTable();
    else if (tableKey === 'records') renderRecordsTable();
}

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('active');
        populatePlantDropdowns();
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('active');
    }
}

// Modal handling
function initModals() {
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.classList.remove('active');
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            const sqlTab = document.getElementById('tab-sql');
            if (sqlTab && sqlTab.classList.contains('active')) {
                runCustomSQL();
            }
        }
    });

    // Programmatically bind ODBC login form to prevent default page refresh
    const odbcForm = document.getElementById('form-odbc-login');
    if (odbcForm) {
        odbcForm.onsubmit = function(e) {
            e.preventDefault();
            e.stopPropagation();
            handleOdbcLogin(e);
            return false;
        };
    }
}

function exportDatabaseSQL() {
    let sql = `-- ================================================\n`;
    sql += `-- GRIDPULSE POWER PLANT DATABASE EXPORT (ORACLE XE)\n`;
    sql += `-- Generated: ${new Date().toISOString()}\n`;
    sql += `-- ================================================\n\n`;

    DB.POWER_PLANT.forEach(p => {
        sql += `INSERT INTO POWER_PLANT VALUES (${p.PLANT_ID}, '${String(p.PLANT_NAME).replace(/'/g, "''")}', '${String(p.LOCATION).replace(/'/g, "''")}', ${p.CAPACITY_MW});\n`;
    });
    sql += `\n`;
    DB.GENERATOR.forEach(g => {
        sql += `INSERT INTO GENERATOR VALUES (${g.GENERATOR_ID}, ${g.PLANT_ID}, '${String(g.GENERATOR_NAME).replace(/'/g, "''")}', '${String(g.STATUS).replace(/'/g, "''")}');\n`;
    });
    sql += `\n`;
    DB.EMPLOYEE.forEach(e => {
        sql += `INSERT INTO EMPLOYEE VALUES (${e.EMPLOYEE_ID}, '${String(e.EMPLOYEE_NAME).replace(/'/g, "''")}', '${String(e.ROLE).replace(/'/g, "''")}', ${e.PLANT_ID});\n`;
    });
    sql += `\n`;
    DB.GENERATION_RECORD.forEach(r => {
        sql += `INSERT INTO GENERATION_RECORD VALUES (${r.RECORD_ID}, ${r.PLANT_ID}, TO_DATE('${r.GENERATION_DATE}', 'YYYY-MM-DD'), ${r.UNITS_GENERATED});\n`;
    });
    if (DB.SCHEMA_STATE.maintenanceTableCreated && DB.MAINTENANCE_LOG.length) {
        sql += `\n`;
        DB.MAINTENANCE_LOG.forEach(m => {
            sql += `INSERT INTO MAINTENANCE_LOG VALUES (${m.LOG_ID}, ${m.PLANT_ID}, TO_DATE('${m.MAINTENANCE_DATE}', 'YYYY-MM-DD'), '${String(m.DESCRIPTION).replace(/'/g, "''")}', ${m.COST}${DB.SCHEMA_STATE.maintenanceHasNotes ? `, '${String(m.NOTES || '').replace(/'/g, "''")}'` : ''});\n`;
        });
    }
    sql += `\nCOMMIT;\n`;

    const blob = new Blob([sql], { type: 'text/sql;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `powerplant_oracle_dump_${new Date().toISOString().slice(0, 10)}.sql`;
    a.click();
    showToast("Oracle SQL export downloaded", "success");
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'fa-info-circle';
    if (type === 'success') icon = 'fa-circle-check';
    else if (type === 'error') icon = 'fa-circle-xmark';

    toast.innerHTML = `
        <i class="fa-solid ${icon}" style="color:${type==='success'?'var(--accent-emerald)':type==='error'?'var(--accent-rose)':'var(--accent-cyan)'}"></i>
        <span>${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = '0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Expose all interactive functions globally on window for inline HTML event handlers
Object.assign(window, {
    openModal,
    closeModal,
    openAddPlant,
    openAddGenerator,
    openAddEmployee,
    openAddRecord,
    openAddMaintenance,
    openEditPlant,
    confirmDeletePlant,
    viewPlantDetails,
    openEditGenerator,
    deleteGenerator,
    openEditEmployee,
    deleteEmployee,
    openEditRecord,
    deleteRecord,
    openEditMaintenance,
    deleteMaintenance,
    savePlant,
    saveGenerator,
    saveEmployee,
    saveRecord,
    saveMaintenance,
    handleOdbcLogin,
    handleOdbcDisconnect,
    handleLogout,
    openSwitchAccountModal,
    syncDatabaseFromOracle,
    exportDatabaseSQL,
    switchTab,
    sortTable,
    exportReportCSV,
    loadReport,
    executeDDLCreateML,
    executeDDLAlterML,
    inspectSchemaColumns,
    clearSQLEditor,
    runCustomSQL,
    loadSQLPreset,
    filterGenerators,
    filterEmployees,
    filterRecords,
    showToast,
    escapeHtml,
    openCreateTableModal,
    addColumnRow,
    removeColumnRow,
    onPkChange,
    updateDdlPreview,
    handleCreateTable,
    confirmDropTable,
    loadOracleSchemaTables,
    filterCatalogTable
});

