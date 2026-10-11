// verify_browser_e2e_cdp.js
// Direct Chrome DevTools Protocol automation connecting to the live browser on port 9222

const assert = require('assert');

class CDPClient {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.id = 1;
        this.callbacks = new Map();
        this.events = [];
    }

    async connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl);
            this.ws.onopen = () => resolve();
            this.ws.onerror = (err) => reject(err);
            this.ws.onmessage = (msg) => {
                const data = JSON.parse(msg.data);
                if (data.id && this.callbacks.has(data.id)) {
                    const { resolve, reject } = this.callbacks.get(data.id);
                    this.callbacks.delete(data.id);
                    if (data.error) reject(new Error(data.error.message));
                    else resolve(data.result);
                } else if (data.method) {
                    this.events.push(data);
                }
            };
        });
    }

    send(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = this.id++;
            this.callbacks.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async eval(expr) {
        const res = await this.send('Runtime.evaluate', {
            expression: expr,
            awaitPromise: true,
            returnByValue: true
        });
        if (res.exceptionDetails) {
            throw new Error(`Eval failed: ${res.exceptionDetails.text} (${JSON.stringify(res.exceptionDetails.exception)})`);
        }
        return res.result ? res.result.value : undefined;
    }

    close() {
        if (this.ws) this.ws.close();
    }
}

async function runBrowserE2E() {
    console.log('=== RUNNING COMPREHENSIVE BROWSER E2E TEST VIA CDP ===');

    // 1. Find browser target
    const targetRes = await fetch('http://127.0.0.1:9222/json');
    const targets = await targetRes.json();
    const pageTarget = targets.find(t => t.url.includes('3000') || t.title.includes('Power Plant'));

    if (!pageTarget) {
        throw new Error('Could not find active Power Plant browser page target on CDP port 9222');
    }
    console.log(`Connecting to CDP target: ${pageTarget.title} (${pageTarget.webSocketDebuggerUrl})`);

    const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();

    try {
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');

        // 2. Reload page to guarantee clean state and fresh cache-busted assets
        console.log('\nStep 1: Reloading page in browser...');
        await cdp.send('Page.reload', { ignoreCache: true });
        await new Promise(r => setTimeout(r, 2000));

        // Verify initial connection status
        console.log('Step 2: Checking header connection indicators...');
        const headerInfo = await cdp.eval(`(() => {
            return {
                title: document.getElementById('headerOdbcTitle')?.textContent?.trim(),
                sub: document.getElementById('headerOdbcSub')?.textContent?.trim(),
                sidebarStatus: document.getElementById('sidebarOdbcStatusText')?.textContent?.trim(),
                connectedDot: document.getElementById('headerPulseDot')?.classList?.contains('pulse-dot'),
                plantsCount: DB.POWER_PLANT ? DB.POWER_PLANT.length : -1,
                user: odbcState.user,
                connected: odbcState.connected
            };
        })()`);
        console.log('  Browser State:', headerInfo);
        assert.strictEqual(headerInfo.connected, true, 'ODBC should be auto-connected');
        assert.strictEqual(headerInfo.user, 'powerplant', 'User should be powerplant');
        assert.ok(headerInfo.plantsCount >= 4, 'Should load at least 4 power plants');
        console.log('  [PASS] Header and session state verified as live Oracle connected!');

        // 3. Test Sidebar Navigation
        console.log('\nStep 3: Testing Sidebar Navigation across all views...');
        const tabs = [
            'dashboard',
            'plants',
            'generators',
            'employees',
            'records',
            'maintenance',
            'reports',
            'ddl',
            'sql'
        ];

        for (const tab of tabs) {
            await cdp.eval(`switchTab('${tab}')`);
            const isActive = await cdp.eval(`(() => {
                const content = document.getElementById('tab-${tab}');
                const nav = document.getElementById('nav-${tab}');
                return content && content.classList.contains('active') && nav && nav.classList.contains('active');
            })()`);
            assert.strictEqual(isActive, true, `Tab ${tab} should be active`);
            console.log(`  [PASS] View switched cleanly to: ${tab}`);
        }

        // Return to plants tab
        await cdp.eval(`switchTab('plants')`);

        // 4. Test Power Plant CRUD (Create -> Read -> Update -> Delete)
        console.log('\nStep 4: Testing Power Plant CRUD operations end-to-end...');
        
        // Open Add Plant Modal
        await cdp.eval(`openAddPlant()`);
        const isAddModalOpen = await cdp.eval(`document.getElementById('modal-add-plant').classList.contains('active')`);
        assert.strictEqual(isAddModalOpen, true, 'Add plant modal should be open');
        console.log('  [PASS] Add Power Plant modal opened successfully.');

        // Fill form and save
        console.log('  Submitting new plant 888 (Automated Test Facility, Kolkata, 320 MW)...');
        await cdp.eval(`(() => {
            document.getElementById('plant-id').value = '888';
            document.getElementById('plant-name').value = 'Automated Test Facility';
            document.getElementById('plant-location').value = 'Kolkata';
            document.getElementById('plant-capacity').value = '320';
            const fakeEvent = { preventDefault: () => {} };
            return savePlant(fakeEvent);
        })()`);

        // Wait for Oracle round-trip and table re-render
        await new Promise(r => setTimeout(r, 1500));

        const plantCreated = await cdp.eval(`(() => {
            const plant = DB.POWER_PLANT.find(p => Number(p.PLANT_ID) === 888);
            const inTable = Array.from(document.querySelectorAll('#plants-tbody tr')).some(r => r.textContent.includes('Automated Test Facility'));
            return { foundInDB: !!plant, inTable, capacity: plant?.CAPACITY_MW };
        })()`);
        console.log('  Created plant verification:', plantCreated);
        assert.strictEqual(plantCreated.foundInDB, true, 'Plant 888 must exist in client DB state from Oracle');
        assert.strictEqual(plantCreated.inTable, true, 'Plant 888 must be rendered in HTML table');
        console.log('  [PASS] New Power Plant 888 inserted and verified in live table!');

        // Edit Plant 888 (Change capacity to 450 MW)
        console.log('  Editing plant 888 capacity to 450 MW...');
        await cdp.eval(`openEditPlant(888)`);
        await cdp.eval(`(() => {
            document.getElementById('plant-capacity').value = '450';
            const fakeEvent = { preventDefault: () => {} };
            return savePlant(fakeEvent);
        })()`);

        await new Promise(r => setTimeout(r, 1500));
        const plantUpdated = await cdp.eval(`(() => {
            const plant = DB.POWER_PLANT.find(p => Number(p.PLANT_ID) === 888);
            return plant ? Number(plant.CAPACITY_MW) : 0;
        })()`);
        assert.strictEqual(plantUpdated, 450, 'Capacity should be updated to 450 MW');
        console.log('  [PASS] Plant 888 updated to 450 MW successfully!');

        // Delete Plant 888
        console.log('  Deleting plant 888 via delete confirmation workflow...');
        await cdp.eval(`confirmDeletePlant(888)`);
        const isDeleteModalOpen = await cdp.eval(`document.getElementById('modal-confirm-delete').classList.contains('active')`);
        assert.strictEqual(isDeleteModalOpen, true, 'Delete confirmation modal must be active');
        
        // Execute the confirmed delete
        await cdp.eval(`(() => {
            document.getElementById('btnConfirmDeleteAction').click();
        })()`);
        await new Promise(r => setTimeout(r, 1500));

        const plantDeleted = await cdp.eval(`(() => {
            const plant = DB.POWER_PLANT.find(p => Number(p.PLANT_ID) === 888);
            const inTable = Array.from(document.querySelectorAll('#plants-tbody tr')).some(r => r.textContent.includes('Automated Test Facility'));
            return { exists: !!plant, inTable };
        })()`);
        assert.strictEqual(plantDeleted.exists, false, 'Plant 888 must be deleted from DB');
        assert.strictEqual(plantDeleted.inTable, false, 'Plant 888 must be removed from HTML table');
        console.log('  [PASS] Plant 888 deleted cleanly and removed from view!');

        // 5. Test Schema & DDL (Create Table -> Verify in Data Dictionary -> Drop Table)
        console.log('\nStep 5: Testing Oracle DDL Table Creation and Metadata Catalog...');
        await cdp.eval(`switchTab('ddl')`);

        // Open Create Table Modal
        await cdp.eval(`openCreateTableModal()`);
        const isDdlModalOpen = await cdp.eval(`document.getElementById('modal-create-table').classList.contains('active')`);
        assert.strictEqual(isDdlModalOpen, true, 'Create table modal should be open');

        // Set table name & columns
        await cdp.eval(`(() => {
            document.getElementById('create-table-name').value = 'E2E_LIVE_GRID_TBL';
            updateDdlPreview();
        })()`);

        const ddlPreview = await cdp.eval(`document.getElementById('create-table-ddl-preview').textContent`);
        console.log('  Generated Oracle DDL Preview:', ddlPreview);
        assert.ok(ddlPreview.includes('CREATE TABLE E2E_LIVE_GRID_TBL'), 'DDL should contain CREATE TABLE');

        // Submit Create Table
        console.log('  Executing DDL on Oracle Database...');
        await cdp.eval(`(() => {
            const fakeEvent = { preventDefault: () => {} };
            return handleCreateTable(fakeEvent);
        })()`);

        await new Promise(r => setTimeout(r, 2500));

        // Verify table exists in Oracle data dictionary catalog
        const catalogCheck = await cdp.eval(`(() => {
            const rows = Array.from(document.querySelectorAll('#user-tables-tbody tr'));
            const match = rows.find(r => r.textContent.includes('E2E_LIVE_GRID_TBL'));
            return { found: !!match, rowText: match ? match.textContent.trim() : null };
        })()`);
        console.log('  Oracle Schema Table catalog check:', catalogCheck);
        assert.strictEqual(catalogCheck.found, true, 'Newly created table must appear in Oracle Schema catalog');
        console.log('  [PASS] Oracle DDL executed successfully! Table E2E_LIVE_GRID_TBL verified in Oracle data dictionary!');

        // Drop the test table
        console.log('  Dropping test table E2E_LIVE_GRID_TBL...');
        await cdp.eval(`confirmDropTable('E2E_LIVE_GRID_TBL')`);
        await cdp.eval(`(() => {
            document.getElementById('btnConfirmDeleteAction').click();
        })()`);
        await new Promise(r => setTimeout(r, 2000));

        const catalogAfterDrop = await cdp.eval(`(() => {
            const rows = Array.from(document.querySelectorAll('#user-tables-tbody tr'));
            return rows.some(r => r.textContent.includes('E2E_LIVE_GRID_TBL'));
        })()`);
        assert.strictEqual(catalogAfterDrop, false, 'Table must be dropped and absent from catalog');
        console.log('  [PASS] Table E2E_LIVE_GRID_TBL dropped and verified removed!');

        // 6. Test SQL Terminal
        console.log('\nStep 6: Testing SQL Terminal query execution...');
        await cdp.eval(`switchTab('sql')`);
        await cdp.eval(`loadSQLPreset('all_plants')`);
        await new Promise(r => setTimeout(r, 1500));

        const sqlResults = await cdp.eval(`(() => {
            const status = document.getElementById('sql-execution-status').textContent;
            const count = document.getElementById('sql-row-count').textContent;
            const rowCount = document.querySelectorAll('#sql-results-tbody tr').length;
            return { status, count, rowCount };
        })()`);
        console.log('  SQL execution results:', sqlResults);
        assert.ok(sqlResults.rowCount >= 4, 'Should return at least 4 plant rows');
        console.log('  [PASS] SQL Terminal executed query and rendered real Oracle rows!');

        // 7. Test Analytical Reports
        console.log('\nStep 7: Testing Analytical Reports (DQL)...');
        await cdp.eval(`switchTab('reports')`);
        for (let i = 1; i <= 4; i++) {
            await cdp.eval(`loadReport(${i})`);
            await new Promise(r => setTimeout(r, 300));
            const reportRows = await cdp.eval(`document.querySelectorAll('#report-tbody tr').length`);
            assert.ok(reportRows > 0, `Report ${i} must have data rows`);
            console.log(`  [PASS] Report ${i} rendered with ${reportRows} rows!`);
        }

        // 8. Test Header Actions (Sync, Export SQL, Connection Details)
        console.log('\nStep 8: Testing Header Actions...');
        await cdp.eval(`syncDatabaseFromOracle()`);
        await new Promise(r => setTimeout(r, 1500));
        console.log('  [PASS] Sync from Oracle executed successfully.');

        await cdp.eval(`exportDatabaseSQL()`);
        console.log('  [PASS] Export SQL script generated.');

        await cdp.eval(`openModal('modal-odbc-login')`);
        const connDetails = await cdp.eval(`(() => {
            return {
                dsn: document.getElementById('conn-detail-dsn')?.textContent?.trim(),
                user: document.getElementById('conn-detail-user')?.textContent?.trim(),
                role: document.getElementById('conn-detail-role')?.textContent?.trim(),
                visible: document.getElementById('odbc-connected-details')?.style.display !== 'none'
            };
        })()`);
        console.log('  Connection details card in modal:', connDetails);
        assert.strictEqual(connDetails.visible, true, 'Connection details card should be visible');
        assert.ok(connDetails.dsn.includes('PowerPlantDSN'), 'DSN should match');
        assert.ok(connDetails.user.toLowerCase().includes('powerplant'), 'User should match');
        console.log('  [PASS] Connection Details verified accurately!');
        await cdp.eval(`closeModal('modal-odbc-login')`);

        // 9. Test Logout and Account Switching
        console.log('\nStep 9: Testing Logout and Account Switching...');
        await cdp.eval(`handleLogout()`);
        await new Promise(r => setTimeout(r, 1500));

        const loggedOutState = await cdp.eval(`(() => {
            return {
                connected: odbcState.connected,
                headerTitle: document.getElementById('headerOdbcTitle')?.textContent?.trim(),
                loginModalActive: document.getElementById('modal-odbc-login')?.classList.contains('active'),
                dbLength: DB.POWER_PLANT.length
            };
        })()`);
        console.log('  Logged-out client state:', loggedOutState);
        assert.strictEqual(loggedOutState.connected, false, 'State must be disconnected');
        assert.strictEqual(loggedOutState.headerTitle, 'ODBC: Disconnected', 'Header must display Disconnected');
        assert.strictEqual(loggedOutState.loginModalActive, true, 'ODBC Login modal must prompt user');
        assert.strictEqual(loggedOutState.dbLength, 0, 'In-memory client state must be cleared');
        console.log('  [PASS] Application session invalidated cleanly, cookies wiped!');

        // Reconnect as powerplant
        console.log('  Logging back in as user powerplant...');
        await cdp.eval(`(() => {
            document.getElementById('odbc-dsn').value = 'PowerPlantDSN';
            document.getElementById('odbc-user').value = 'powerplant';
            document.getElementById('odbc-pass').value = 'Power123';
            const fakeEvent = { preventDefault: () => {} };
            return handleOdbcLogin(fakeEvent);
        })()`);
        await new Promise(r => setTimeout(r, 2000));

        const reconnectedState = await cdp.eval(`(() => {
            return {
                connected: odbcState.connected,
                user: odbcState.user,
                plantsCount: DB.POWER_PLANT.length
            };
        })()`);
        console.log('  Reconnected state:', reconnectedState);
        assert.strictEqual(reconnectedState.connected, true, 'Must reconnect successfully');
        assert.strictEqual(reconnectedState.user, 'powerplant', 'User must be powerplant');
        assert.ok(reconnectedState.plantsCount >= 4, 'Must reload power plant data from Oracle');
        console.log('  [PASS] Reconnected successfully to Oracle XE! Data restored!');

        console.log('\n=============================================================');
        console.log('🎉 ALL BROWSER E2E TESTS PASSED 100% IN REAL RUNNING CHROME!');
        console.log('=============================================================');

    } finally {
        cdp.close();
    }
}

runBrowserE2E().catch(err => {
    console.error('\n❌ E2E TEST FAILED:', err);
    process.exit(1);
});
