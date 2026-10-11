const assert = require('assert');

async function testCrudAndPersistence() {
    console.log('=== TESTING CRUD OPERATIONS, PERSISTENCE & DISCONNECT ===\n');
    const BASE = 'http://127.0.0.1:3000';

    // 1. Get CSRF & Session
    const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
    const rawCookies = csrfRes.headers.get('set-cookie') || '';
    const sidCookieMatch = rawCookies.match(/gridpulse\.sid=([^;]+)/);
    const cookie = `gridpulse.sid=${sidCookieMatch[1]}`;
    const { csrfToken } = await csrfRes.json();
    console.log('1. Session cookie & CSRF obtained.');

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
    assert.strictEqual(connRes.status, 200);
    const connData = await connRes.json();
    assert.strictEqual(connData.success, true);
    console.log('2. Connected to Oracle via PowerPlantDSN as powerplant (Role: ' + connData.role + ')');

    // 3. Verify session persistence on /api/odbc/status (simulating page reload)
    const statusRes = await fetch(`${BASE}/api/odbc/status`, {
        headers: { 'Cookie': cookie }
    });
    assert.strictEqual(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.strictEqual(statusData.connected, true);
    assert.strictEqual(statusData.user, 'powerplant');
    console.log('3. Session persistence verified on /api/odbc/status (connected: true, user: ' + statusData.user + ')');

    // 4. Test CRUD - INSERT a test plant (ID: 999)
    const insertRes = await fetch(`${BASE}/api/odbc/query`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie,
            'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({
            sql: "INSERT INTO POWER_PLANT (PLANT_ID, PLANT_NAME, LOCATION, CAPACITY_MW) VALUES (999, 'Solar Alpha Farm', 'Gujarat', 150)"
        })
    });
    assert.strictEqual(insertRes.status, 200);
    console.log('4. INSERT test plant (ID: 999) succeeded.');

    // 5. Verify live data includes plant 999
    const dataRes = await fetch(`${BASE}/api/odbc/data`, {
        headers: { 'Cookie': cookie }
    });
    assert.strictEqual(dataRes.status, 200);
    const data = await dataRes.json();
    const createdPlant = data.POWER_PLANT.find(p => Number(p.PLANT_ID) === 999);
    assert.ok(createdPlant, 'Plant 999 must exist in Oracle database');
    assert.strictEqual(createdPlant.PLANT_NAME, 'Solar Alpha Farm');
    console.log('5. Verified plant 999 retrieved in live data:', createdPlant);

    // 6. Test CRUD - UPDATE the test plant
    const updateRes = await fetch(`${BASE}/api/odbc/query`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie,
            'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({
            sql: "UPDATE POWER_PLANT SET CAPACITY_MW = 200 WHERE PLANT_ID = 999"
        })
    });
    assert.strictEqual(updateRes.status, 200);
    console.log('6. UPDATE test plant capacity to 200 MW succeeded.');

    // 7. Test CRUD - DELETE the test plant
    const deleteRes = await fetch(`${BASE}/api/odbc/query`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie,
            'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({
            sql: "DELETE FROM POWER_PLANT WHERE PLANT_ID = 999"
        })
    });
    assert.strictEqual(deleteRes.status, 200);
    console.log('7. DELETE test plant (ID: 999) succeeded.');

    // 8. Verify plant 999 is gone
    const verifyRes = await fetch(`${BASE}/api/odbc/data`, {
        headers: { 'Cookie': cookie }
    });
    const verifyData = await verifyRes.json();
    const deletedPlant = verifyData.POWER_PLANT.find(p => Number(p.PLANT_ID) === 999);
    assert.strictEqual(deletedPlant, undefined, 'Plant 999 must be deleted');
    console.log('8. Verified plant 999 no longer exists in Oracle.');

    // 9. Test Disconnect
    const discRes = await fetch(`${BASE}/api/odbc/disconnect`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie,
            'X-CSRF-Token': csrfToken
        }
    });
    assert.strictEqual(discRes.status, 200);
    console.log('9. Disconnect successful.');

    const discSetCookie = discRes.headers.get('set-cookie') || '';
    const updatedCookie = discSetCookie.includes('gridpulse_logged_out=1') 
        ? `${cookie}; gridpulse_logged_out=1` 
        : cookie;

    // 10. Verify /api/odbc/status reports disconnected
    const postDiscStatus = await fetch(`${BASE}/api/odbc/status`, {
        headers: { 'Cookie': updatedCookie }
    });
    const postDiscData = await postDiscStatus.json();
    assert.strictEqual(postDiscData.connected, false);
    console.log('10. Status verified: disconnected: true.');

    console.log('\n=== ALL CRUD, PERSISTENCE & DISCONNECT TESTS PASSED! ===');
}

testCrudAndPersistence().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
