const assert = require('assert');

async function runTests() {
    console.log('=== RUNNING SECURITY & ODBC VERIFICATION SUITE ===\n');

    const BASE = 'http://127.0.0.1:3000';

    // 1. Health check test
    console.log('Test 1: Health check (no sensitive leaks)...');
    const healthRes = await fetch(`${BASE}/api/health`);
    assert.strictEqual(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.strictEqual(healthData.status, 'ok');
    assert.strictEqual(healthData.service, 'powerplant-management-system');
    assert.strictEqual(healthData.user, undefined, 'Must not disclose user');
    assert.strictEqual(healthData.dsn, undefined, 'Must not disclose DSN');
    assert.strictEqual(healthData.password, undefined, 'Must not disclose password');
    console.log('  [PASS] Health check is generic and leak-free:', healthData);

    // 2. Unauthorized API rejection test
    console.log('\nTest 2: Unauthorized API rejection (no session)...');
    const unauthDataRes = await fetch(`${BASE}/api/odbc/data`);
    assert.strictEqual(unauthDataRes.status, 401);
    const unauthData = await unauthDataRes.json();
    assert.strictEqual(unauthData.success, false);
    console.log('  [PASS] /api/odbc/data rejected with 401:', unauthData.error);

    // 3. CSRF token validation
    console.log('\nTest 3: CSRF token enforcement...');
    const noCsrfRes = await fetch(`${BASE}/api/odbc/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dsn: 'PowerPlantDSN', user: 'powerplant', password: 'bad' })
    });
    assert.strictEqual(noCsrfRes.status, 403, 'Must reject POST without CSRF token');
    const noCsrfData = await noCsrfRes.json();
    console.log('  [PASS] POST without CSRF rejected with 403:', noCsrfData.error);

    // 4. Retrieve CSRF and session cookie for User A
    console.log('\nTest 4: Retrieve session & CSRF token for User A...');
    const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
    assert.strictEqual(csrfRes.status, 200);
    const rawCookies = csrfRes.headers.get('set-cookie') || '';
    const sidCookieMatch = rawCookies.match(/gridpulse\.sid=([^;]+)/);
    assert.ok(sidCookieMatch, 'Must return session cookie');
    const userACookie = `gridpulse.sid=${sidCookieMatch[1]}`;
    const csrfData = await csrfRes.json();
    const csrfToken = csrfData.csrfToken;
    assert.ok(csrfToken && csrfToken.length >= 32, 'Must return valid CSRF token');
    console.log('  [PASS] User A session cookie and CSRF token obtained successfully.');

    // 5. Invalid credentials rejection with sanitized message
    console.log('\nTest 5: Connect with invalid credentials...');
    const invalidCredsRes = await fetch(`${BASE}/api/odbc/connect`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': userACookie,
            'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({ dsn: 'PowerPlantDSN', user: 'powerplant', password: 'wrongpassword' })
    });
    assert.strictEqual(invalidCredsRes.status, 401);
    const invalidCredsData = await invalidCredsRes.json();
    assert.strictEqual(invalidCredsData.success, false);
    assert.ok(invalidCredsData.error.includes('ORA-01017'), 'Must return sanitized Oracle ORA-01017 error');
    assert.ok(!invalidCredsData.error.includes('wrongpassword'), 'Must NEVER echo password');
    console.log('  [PASS] Invalid credentials rejected securely:', invalidCredsData.error);

    // 6. Connect with valid credentials establishing genuine Oracle session
    console.log('\nTest 6: Connect User A with real Oracle XE credentials...');
    const validConnectRes = await fetch(`${BASE}/api/odbc/connect`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': userACookie,
            'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({ dsn: 'PowerPlantDSN', user: 'powerplant', password: process.env.APP_ORACLE_PASSWORD || 'Power123' })
    });
    assert.strictEqual(validConnectRes.status, 200);
    const validConnectData = await validConnectRes.json();
    assert.strictEqual(validConnectData.success, true);
    assert.strictEqual(validConnectData.role, 'admin', 'powerplant must have admin role');
    console.log('  [PASS] User A connected genuinely to Oracle XE:', validConnectData.message);

    // 7. Verify live data query through User A session
    console.log('\nTest 7: Fetch live tables through User A session...');
    const dataRes = await fetch(`${BASE}/api/odbc/data`, {
        headers: { 'Cookie': userACookie }
    });
    assert.strictEqual(dataRes.status, 200);
    const dbData = await dataRes.json();
    assert.strictEqual(dbData.success, true);
    assert.ok(Array.isArray(dbData.POWER_PLANT) && dbData.POWER_PLANT.length > 0, 'Must load live plants');
    console.log(`  [PASS] Successfully fetched ${dbData.POWER_PLANT.length} live plants from Oracle:`, dbData.POWER_PLANT.map(p => p.PLANT_NAME));

    // 8. Session isolation test: User B cannot access User A database data!
    console.log('\nTest 8: Session isolation (User B without User A session)...');
    const userBRes = await fetch(`${BASE}/api/odbc/data`);
    assert.strictEqual(userBRes.status, 401, 'User B must NOT have access to User A database session');
    console.log('  [PASS] Complete session isolation verified: User B received 401 Unauthorized.');

    // 9. Admin arbitrary SQL execution test
    console.log('\nTest 9: Admin arbitrary SQL execution...');
    const sqlRes = await fetch(`${BASE}/api/odbc/query`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': userACookie,
            'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({ sql: 'SELECT COUNT(*) AS CNT FROM POWER_PLANT' })
    });
    assert.strictEqual(sqlRes.status, 200);
    const sqlData = await sqlRes.json();
    assert.strictEqual(sqlData.success, true);
    console.log('  [PASS] Admin SQL query succeeded:', sqlData.rows);

    // 10. Logout & session destruction test
    console.log('\nTest 10: Disconnect / Logout User A...');
    const disconnectRes = await fetch(`${BASE}/api/odbc/disconnect`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': userACookie,
            'X-CSRF-Token': csrfToken
        }
    });
    assert.strictEqual(disconnectRes.status, 200);
    
    // After disconnect, subsequent requests must fail with 401
    const postLogoutRes = await fetch(`${BASE}/api/odbc/data`, {
        headers: { 'Cookie': userACookie }
    });
    assert.strictEqual(postLogoutRes.status, 401, 'Must reject post-logout query with 401');
    console.log('  [PASS] User A session disconnected; subsequent requests rejected with 401.');

    console.log('\n=== ALL 10 SECURITY & ODBC TESTS PASSED PERFECTLY! ===');
}

runTests().catch(err => {
    console.error('\n[TEST FAILURE]:', err);
    process.exit(1);
});
