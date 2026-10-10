# Power Plant Management System (Oracle XE + ODBC)

A full-stack Relational Database Management System (RDBMS) GUI & Assessment Dashboard for Oracle XE using the Windows ODBC API, Node.js Express backend, and a modern frontend dashboard.

---

## 🚀 Quick Start (Windows Lab PC)

### 1. Start the Application
Simply double-click:
```cmd
start.bat
```
*(or run `start_web.bat` / run `npm start` in your terminal)*

This script automatically:
1. Detects your Node.js runtime.
2. Installs required lightweight dependencies (`express`, `cors`, `odbc`) if not already present.
3. Launches your default web browser to: **[http://localhost:3000](http://localhost:3000)**.
4. Starts the Express backend server listening on port `3000`.

---

## 🛠️ Prerequisites for College Computer Lab

To run this application and connect live to Oracle XE via ODBC, ensure the lab machine has:

1. **Node.js (LTS version: v18, v20, or v22)**
   - Download: [https://nodejs.org/](https://nodejs.org/)
   - Verify in terminal: `node -v` and `npm -v`

2. **Oracle Database 11g/18c/19c/21c XE**
   - Ensure the Windows services are running:
     - `OracleServiceXE`
     - `OracleXETNSListener`
   - Verify in Windows Services (`services.msc`) or via PowerShell:
     ```powershell
     Get-Service *Oracle*
     ```

3. **64-bit Oracle ODBC Driver**
   - Typically installed automatically with Oracle XE as **`Oracle in XE`** (or `Oracle in OraClient11g_home1`).
   - Check using 64-bit ODBC Administrator: `odbcad32.exe`.

4. **Configured ODBC Data Source Name (DSN)**
   - **DSN Name**: `PowerPlantDSN` (or your assigned lab DSN name, e.g., `LabOracle`, `MDBMS_ORACLE`).
   - **How to create/verify in lab**:
     1. Press `Win + R`, type `odbcad32.exe` and press Enter.
     2. Click the **System DSN** (or User DSN) tab.
     3. Ensure a DSN named `PowerPlantDSN` exists pointing to driver **`Oracle in XE`**.
     4. Set **TNS Service Name** to `XE` (or your lab Oracle service, e.g. `ORCL`).
     5. Click **Test Connection** to confirm connectivity.

---

## 🔑 Connecting via ODBC in the Web GUI

1. Open **[http://localhost:3000](http://localhost:3000)** in your browser.
2. Click **ODBC Login** (or the connection indicator in the header/sidebar).
3. Enter your connection credentials:
   - **ODBC DSN Name**: `PowerPlantDSN` (or your custom DSN)
   - **Oracle Username**: `powerplant` (or your student roll number schema, e.g. `25BCE1371`)
   - **Oracle Password**: your Oracle schema password
4. Click **Connect via ODBC**.
5. Once authenticated, the GUI dynamically queries and synchronizes all live tables (`POWER_PLANT`, `GENERATOR`, `EMPLOYEE`, `GENERATION_RECORD`, `MAINTENANCE_LOG`) straight from Oracle XE!

---

## 🩺 Diagnostics & Health Check

You can verify the backend status at any time:
- **Health Check URL**: [http://localhost:3000/api/health](http://localhost:3000/api/health)
- **JSON Response**:
  ```json
  {
    "status": "ok",
    "service": "powerplant-assessment-backend",
    "version": "1.0.0",
    "port": 3000,
    "uptimeSeconds": 45,
    "odbc": {
      "driverEngine": "Native Node.js ODBC (active)",
      "connected": true,
      "dsn": "PowerPlantDSN",
      "user": "powerplant"
    }
  }
  ```

---

## 🔍 Root Cause Analysis of Previous Connection Errors

### Why did `Server Error: Failed to fetch` occur?
1. **Frontend running via `file://` protocol**: When `index.html` was opened directly as a file without the Node.js server running, browser security prevented relative API requests (`fetch('/api/odbc/connect')` became `file:///api/odbc/connect`), producing `Failed to fetch`.
2. **Backend Server Offline / Process Crash**: The previous bridge used an unhandled child process spawn (`spawn('py', ['-3.13', ...])`). When the specific Python executable wasn't found or emitted errors, Node.js emitted an unhandled `error` event, crashing the server process silently.
3. **Missing Direct Node ODBC Driver**: The backend relied entirely on shelling out to a secondary Python runtime via stdin/stdout pipes instead of a native high-performance Node ODBC integration.

### Fixes Applied:
- Integrated **native Node.js `odbc` driver** connecting directly through Windows 64-bit ODBC driver manager (`SQLDriverConnect`).
- Built a **failsafe Python `odbc_bridge.py` fallback** that cleans null bytes, handles multi-python binaries, and catches all process errors so the Node server never crashes.
- Implemented **dynamic API routing (`API_BASE` / `apiUrl`)** in `app.js` with CORS support for localhost and file protocols.
- Added comprehensive **`GET /api/health`** endpoint and input validation.
- Created **`start.bat`** and enhanced **`start_web.bat`** for lab execution.
- Added descriptive, user-friendly error translations for Oracle error codes (e.g., `ORA-01017`, `IM002`, `ORA-12541`, `ORA-01034`, `ORA-28000`).

---

## ⚡ Application Features
- **Live Oracle Synchronized Dashboard**: Plant capacity metrics, generation logs, generator health.
- **Relational CRUD Management**: Full insert, edit, view, and delete operations on `POWER_PLANT`, `GENERATOR`, `EMPLOYEE`, and `GENERATION_RECORD`.
- **Live SQL Terminal**: Run custom `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER` queries directly against Oracle XE with millisecond execution timers.
- **DDL Maintenance Module**: One-click creation and alteration of `MAINTENANCE_LOG` with live Oracle data dictionary inspection (`USER_TAB_COLUMNS`).
- **DQL Reports**: Group By, Aggregations (`SUM`, `AVG`, `COUNT`), and Multi-table Joins with CSV export.
