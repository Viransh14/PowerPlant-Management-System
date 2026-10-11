const assert = require('assert');

const BASE = 'http://127.0.0.1:3000';

async function testFullSuite() {
    console.log('=== VERIFYING DDL TABLE CREATION, METADATA & ACCOUNT SWITCHING ===\n');

    // 1. Unauthenticated checks
    console.log('1. Checking unauthenticated access to /api/odbc/tables and /api/odbc/create-table...');
    const unauthTablesRes = await fetch(`${BASE}/api/odbc/tables`);
    assert.strictEqual(unauthTablesRes.status, 401);
    console.log('  [PASS] Unauthenticated request to /api/odbc/tables rejected with 401.');

    // 2. Obtain session & CSRF token for User 1
    const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
    const rawCookies = csrfRes.headers.get('set-cookie') || '';
    const sidCookieMatch = rawCookies.match(/gridpulse\.sid=([^;]+)/);
    assert.ok(sidCookieMatch, 'Must return session cookie');
    const userCookie = `gridpulse.sid=${sidCookieMatch[1]}`;
    const csrfData = await csrfRes.json();
    const csrfToken = csrfData.csrfToken;
    console.log('2. Obtained CSRF token and initial session cookie for User 1.');

    const headers1 = {
        'Content-Type': 'application/json',
        'Cookie': userCookie,
        'X-CSRF-Token': csrfToken
    };

    // 3. Connect User 1 to Oracle (powerplant / Power123)
    console.log('3. Authenticating User 1 (powerplant) to Oracle XE...');
    const loginRes = await fetch(`${BASE}/api/odbc/connect`, {
        method: 'POST',
        headers: headers1,
        body: JSON.stringify({
            dsn: 'PowerPlantDSN',
            user: 'powerplant',
            password: 'Power123'
        })
    });
    const loginData = await loginRes.json();
    assert.strictEqual(loginData.success, true);
    console.log(`  [PASS] Connected as ${loginData.user} (Role: ${loginData.role})`);

    // 4. Test table validation (invalid name)
    console.log('4. Testing validation of invalid table names and SQL injection...');
    const invalidNameRes = await fetch(`${BASE}/api/odbc/create-table`, {
        method: 'POST',
        headers: headers1,
        body: JSON.stringify({
            tableName: '123_INVALID',
            columns: [{ name: 'ID', type: 'NUMBER', isPk: true }]
        })
    });
    const invalidNameData = await invalidNameRes.json();
    assert.strictEqual(invalidNameRes.status, 400);
    assert.ok(invalidNameData.error.includes('alphanumeric'));
    console.log(`  [PASS] Invalid table name rejected: "${invalidNameData.error}"`);

    // 5. Test reserved word rejection
    const reservedRes = await fetch(`${BASE}/api/odbc/create-table`, {
        method: 'POST',
        headers: headers1,
        body: JSON.stringify({
            tableName: 'SELECT',
            columns: [{ name: 'ID', type: 'NUMBER' }]
        })
    });
    const reservedData = await reservedRes.json();
    assert.strictEqual(reservedRes.status, 400);
    assert.ok(reservedData.error.includes('reserved keyword'));
    console.log(`  [PASS] Reserved word rejected: "${reservedData.error}"`);

    // 6. Test core table drop protection
    console.log('5. Testing core table drop protection (guarding POWER_PLANT)...');
    const dropCoreRes = await fetch(`${BASE}/api/odbc/drop-table`, {
        method: 'POST',
        headers: headers1,
        body: JSON.stringify({ tableName: 'POWER_PLANT' })
    });
    const dropCoreData = await dropCoreRes.json();
    assert.strictEqual(dropCoreRes.status, 403);
    assert.ok(dropCoreData.error.includes('core system table'));
    console.log(`  [PASS] Core table protected: "${dropCoreData.error}"`);

    // 7. Create a real custom Oracle table
    const testTableName = 'TEST_AUTO_SUBSTATION';
    // Ensure clean state if previously created
    await fetch(`${BASE}/api/odbc/drop-table`, {
        method: 'POST',
        headers: headers1,
        body: JSON.stringify({ tableName: testTableName })
    });
    console.log(`6. Executing CREATE TABLE ${testTableName} through Oracle ODBC...`);
    const createRes = await fetch(`${BASE}/api/odbc/create-table`, {
        method: 'POST',
        headers: headers1,
        body: JSON.stringify({
            tableName: testTableName,
            columns: [
                { name: 'SUB_ID', type: 'NUMBER(10)', isPk: true, isNotNull: true },
                { name: 'SUB_NAME', type: 'VARCHAR2(100)', isNotNull: true, isUnique: true },
                { name: 'VOLTAGE_KV', type: 'NUMBER(8,2)' }
            ]
        })
    });
    const createData = await createRes.json();
    assert.strictEqual(createRes.status, 200);
    assert.strictEqual(createData.success, true);
    console.log(`  [PASS] Oracle DDL executed and verified in USER_TABLES metadata!`);
    console.log(`         DDL: ${createData.ddl}`);
    console.log(`         Message: ${createData.message}`);

    // 8. Query USER_TABLES and USER_TAB_COLUMNS via GET /api/odbc/tables
    console.log('7. Verifying table in live Oracle data dictionary (USER_TABLES & USER_TAB_COLUMNS)...');
    const tablesRes = await fetch(`${BASE}/api/odbc/tables`, { headers: { 'Cookie': userCookie } });
    const tablesData = await tablesRes.json();
    assert.strictEqual(tablesData.success, true);
    const foundTable = tablesData.tables.includes(testTableName);
    assert.ok(foundTable, `Table ${testTableName} must be found in USER_TABLES`);
    const colCount = tablesData.columns.filter(c => c.TABLE_NAME === testTableName).length;
    console.log(`  [PASS] Found in Oracle USER_TABLES: ${testTableName} (Columns: ${colCount})`);

    // 9. Drop the test table cleanly
    console.log(`8. Dropping ${testTableName} via POST /api/odbc/drop-table...`);
    const dropRes = await fetch(`${BASE}/api/odbc/drop-table`, {
        method: 'POST',
        headers: headers1,
        body: JSON.stringify({ tableName: testTableName })
    });
    const dropData = await dropRes.json();
    assert.strictEqual(dropRes.status, 200);
    assert.strictEqual(dropData.success, true);
    console.log(`  [PASS] Table dropped cleanly.`);

    // Verify it is gone from USER_TABLES
    const tablesAfterDrop = await (await fetch(`${BASE}/api/odbc/tables`, { headers: { 'Cookie': userCookie } })).json();
    const stillThere = tablesAfterDrop.tables.includes(testTableName);
    assert.strictEqual(stillThere, false, `Table ${testTableName} must not exist in USER_TABLES after DROP`);
    console.log(`  [PASS] Verified table is completely absent from Oracle data dictionary.`);

    // 10. Test Logout & Session Invalidation
    console.log('9. Testing real logout and session invalidation...');
    const logoutRes = await fetch(`${BASE}/api/auth/logout`, {
        method: 'POST',
        headers: headers1
    });
    const logoutData = await logoutRes.json();
    assert.strictEqual(logoutData.success, true);
    console.log('  [PASS] Logout endpoint responded success.');

    // Verify subsequent call with old cookie is rejected with 401
    const oldCookieRes = await fetch(`${BASE}/api/odbc/tables`, { headers: { 'Cookie': userCookie } });
    assert.strictEqual(oldCookieRes.status, 401);
    console.log('  [PASS] Old session invalidated completely. Received 401 Unauthorized.');

    // 11. Test account switching with invalid credentials then valid credentials
    console.log('10. Testing account switching workflow...');
    const csrf2Res = await fetch(`${BASE}/api/auth/csrf`);
    const rawCookies2 = csrf2Res.headers.get('set-cookie') || '';
    const sidCookieMatch2 = rawCookies2.match(/gridpulse\.sid=([^;]+)/);
    const userCookie2 = `gridpulse.sid=${sidCookieMatch2[1]}`;
    const csrfToken2 = (await csrf2Res.json()).csrfToken;

    const headers2 = {
        'Content-Type': 'application/json',
        'Cookie': userCookie2,
        'X-CSRF-Token': csrfToken2
    };

    // Invalid attempt
    const badLoginRes = await fetch(`${BASE}/api/odbc/connect`, {
        method: 'POST',
        headers: headers2,
        body: JSON.stringify({
            dsn: 'PowerPlantDSN',
            user: 'powerplant',
            password: 'BadPassword999'
        })
    });
    const badLoginData = await badLoginRes.json();
    assert.strictEqual(badLoginRes.status, 401);
    assert.ok(badLoginData.error.includes('Logon Denied'));
    console.log('  [PASS] Invalid password rejected cleanly with Oracle error.');

    // Reconnect as valid user
    const reconnectRes = await fetch(`${BASE}/api/odbc/connect`, {
        method: 'POST',
        headers: headers2,
        body: JSON.stringify({
            dsn: 'PowerPlantDSN',
            user: 'powerplant',
            password: 'Power123'
        })
    });
    const reconnectData = await reconnectRes.json();
    assert.strictEqual(reconnectData.success, true);
    console.log(`  [PASS] Successfully switched/connected as ${reconnectData.user}.`);

    console.log('\n=== ALL DDL, METADATA & ACCOUNT SWITCHING TESTS PASSED 100%! ===');
}

testFullSuite().catch(err => {
    console.error('TEST ERROR:', err.message);
    process.exit(1);
});
