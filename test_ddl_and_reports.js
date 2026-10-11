const assert = require('assert');

async function testDdlAndReports() {
    console.log('=== TESTING DDL, REPORTS & SCHEMA INSPECTION ===\n');
    const BASE = 'http://127.0.0.1:3000';

    // 1. Session & CSRF
    const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
    const rawCookies = csrfRes.headers.get('set-cookie') || '';
    const sidCookieMatch = rawCookies.match(/gridpulse\.sid=([^;]+)/);
    const cookie = `gridpulse.sid=${sidCookieMatch[1]}`;
    const { csrfToken } = await csrfRes.json();

    // 2. Connect
    const connRes = await fetch(`${BASE}/api/odbc/connect`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie,
            'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({ dsn: 'PowerPlantDSN', user: 'powerplant', password: 'Power123' })
    });
    const connData = await connRes.json();
    assert.strictEqual(connData.success, true);
    console.log('1. Connected to Oracle via PowerPlantDSN.');

    // 3. Check if MAINTENANCE_LOG exists, if not create it
    const checkTableRes = await fetch(`${BASE}/api/odbc/query`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie,
            'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({
            sql: "SELECT COUNT(*) AS CNT FROM USER_TABLES WHERE TABLE_NAME = 'MAINTENANCE_LOG'"
        })
    });
    const checkTableData = await checkTableRes.json();
    const tableExists = checkTableData.rows && checkTableData.rows[0] && checkTableData.rows[0].CNT > 0;
    console.log('2. MAINTENANCE_LOG exists in Oracle:', tableExists);

    if (!tableExists) {
        console.log('3. Executing CREATE TABLE MAINTENANCE_LOG...');
        const createRes = await fetch(`${BASE}/api/odbc/query`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cookie': cookie,
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({
                sql: "CREATE TABLE MAINTENANCE_LOG (LOG_ID NUMBER PRIMARY KEY, PLANT_ID NUMBER REFERENCES POWER_PLANT(PLANT_ID), MAINTENANCE_DATE DATE, DESCRIPTION VARCHAR2(300), COST NUMBER)"
            })
        });
        const createData = await createRes.json();
        assert.strictEqual(createData.success, true);
        console.log('   CREATE TABLE succeeded in Oracle!');
    }

    // 4. Test USER_TAB_COLUMNS schema inspector query
    console.log('4. Testing USER_TAB_COLUMNS schema inspection query...');
    const catRes = await fetch(`${BASE}/api/odbc/query`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie,
            'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({
            sql: "SELECT TABLE_NAME, COLUMN_ID, COLUMN_NAME, DATA_TYPE, NULLABLE FROM USER_TAB_COLUMNS WHERE TABLE_NAME IN ('POWER_PLANT','GENERATOR','EMPLOYEE','GENERATION_RECORD','MAINTENANCE_LOG') ORDER BY TABLE_NAME, COLUMN_ID"
        })
    });
    const catData = await catRes.json();
    assert.strictEqual(catData.success, true);
    console.log(`   Found ${catData.rows.length} columns in Oracle data dictionary.`);

    // 5. Test Reports Queries
    console.log('5. Testing Report 1 query (JOIN + SUM + GROUP BY)...');
    const r1Res = await fetch(`${BASE}/api/odbc/query`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie,
            'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({
            sql: "SELECT p.PLANT_NAME, p.CAPACITY_MW, NVL(SUM(g.UNITS_GENERATED), 0) AS TOTAL_UNITS, COUNT(g.RECORD_ID) AS RECORD_COUNT FROM POWER_PLANT p LEFT JOIN GENERATION_RECORD g ON p.PLANT_ID = g.PLANT_ID GROUP BY p.PLANT_NAME, p.CAPACITY_MW ORDER BY TOTAL_UNITS DESC"
        })
    });
    const r1Data = await r1Res.json();
    assert.strictEqual(r1Data.success, true);
    console.log('   Report 1 rows:', r1Data.rows);

    console.log('\n=== ALL DDL, SCHEMA & REPORT TESTS PASSED PERFECTLY! ===');
}

testDdlAndReports().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
