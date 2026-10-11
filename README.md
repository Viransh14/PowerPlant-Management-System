# Power Plant Management System (Production Security & Oracle XE Deployment)

A full-stack Relational Database Management System (RDBMS) GUI & Assessment Dashboard for Oracle XE using the Windows ODBC API, Node.js Express backend with production-grade security, per-user session isolation, role-based authorization, and Cloudflare Tunnel deployment readiness.

Repository: [https://github.com/Viransh14/PowerPlant-Management-System](https://github.com/Viransh14/PowerPlant-Management-System)

---

## 🔒 Security Architecture & Implementations

### 1. Per-User Session Isolation (No Shared Global State)
- Replaced the single global `activeSession` with isolated, session-scoped credentials stored in `req.session.oracleSession`.
- Signed HTTP-only session cookies (`gridpulse.sid`) with configurable expiration (`SESSION_TIMEOUT_MINUTES=120`).
- Credentials belonging to User A are never accessible to, shared with, or visible to User B.
- Logging out via `/api/odbc/disconnect` securely destroys the user's session on the server.

### 2. Cross-Site Request Forgery (CSRF) Protection
- Implemented cryptographic session-bound CSRF token validation (`crypto.randomBytes(32)`).
- All state-changing requests (`POST /api/odbc/connect`, `/api/odbc/disconnect`, `/api/odbc/query`, `/api/odbc/init-schema`) require a matching `X-CSRF-Token` header.
- Unauthenticated or missing CSRF tokens are rejected immediately with `403 Forbidden`.

### 3. Role-Based Access Control (RBAC) & SQL Restriction
- Configurable administrator list via `ADMIN_USERS=powerplant,system,admin`.
- **Administrator Role**: Authorized to execute arbitrary custom queries, reports, and DDL in the Live SQL Terminal.
- **Operator Role (Least-Privilege)**: Restricted strictly to standard application CRUD operations (`POWER_PLANT`, `GENERATOR`, `EMPLOYEE`, `GENERATION_RECORD`, `MAINTENANCE_LOG`). Arbitrary administrative statements (`DROP`, `GRANT`, `ALTER USER`, etc.) are blocked with `403 Forbidden`.

### 4. Advanced Network & Protocol Hardening
- **Local Loopback Binding**: Express binds to `127.0.0.1` (`HOST=127.0.0.1`), ensuring the server and Oracle XE port `1521` are never exposed directly to the public internet or local area network.
- **Strict Origin Policy (No Permissive CORS)**: Frontend and API are served from the same Express origin. Cross-origin access is blocked unless specifically whitelisted in `ALLOWED_ORIGINS`.
- **Security Headers (Helmet)**: Configured with Content Security Policy (CSP), `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and clickjacking protection.
- **Rate Limiting**:
  - `loginLimiter`: 15 login attempts per 15 minutes per IP to prevent brute-force attacks.
  - `apiLimiter`: 180 requests per minute per IP to protect against resource flooding.
- **Request Body Capping**: Express JSON parser strictly limited to `100kb`.
- **Safe Subprocess Execution**: External Python subprocesses run with `shell: false`, array arguments, JSON stdin streaming, and a 10-second timeout failsafe to prevent command injection and hung processes.

---

## 🛠️ Prerequisites & Setup

### 1. Lab Computer / Windows PC Requirements
1. **Node.js**: LTS version (v18, v20, or v22) installed with `npm`.
2. **Oracle Database XE**: Oracle 11g, 18c, 19c, or 21c XE running locally.
   - Verify Windows services in PowerShell:
     ```powershell
     Get-Service *Oracle*
     ```
     Ensure `OracleServiceXE` and `OracleXETNSListener` are in `Running` state.
3. **64-bit Oracle ODBC Driver**:
   - Installed with Oracle XE under the name **`Oracle in XE`**.
4. **ODBC Data Source Name (DSN)**:
   - Configure a System or User DSN in 64-bit ODBC Administrator:
     1. Press `Win + R`, enter `odbcad32.exe`.
     2. In **System DSN**, click **Add** and select **`Oracle in XE`**.
     3. **Data Source Name**: `PowerPlantDSN`.
     4. **TNS Service Name**: `XE` (or your local service, e.g. `ORCL`).
     5. Test connection and save.

### 2. Creating a Least-Privilege Oracle User
You do **not** need `SYS`, `SYSTEM`, or `DBA` privileges for standard operation. To create a dedicated, least-privilege user, run the following in SQL*Plus:
```sql
-- Connect as SYSDBA
CONNECT / AS SYSDBA;

-- Create application schema
CREATE USER powerplant IDENTIFIED BY powerplant
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp
  QUOTA UNLIMITED ON users;

-- Grant minimal required privileges
GRANT CREATE SESSION, CREATE TABLE, RESOURCE TO powerplant;

-- (Optional) If running schema creation script:
CONNECT powerplant/powerplant;
@powerplant.sql;
```

---

## 🚀 Running the Project

### 1. Configure Environment Secrets
Copy `.env.example` to `.env`:
```cmd
copy .env.example .env
```
*(A default `.env` is already configured for local testing with `HOST=127.0.0.1` and `PORT=3000`)*.

### 2. Start the Server
Run the Windows startup script:
```cmd
start.bat
```
Or via terminal:
```bash
npm start
```

Open your browser to: **[http://localhost:3000](http://localhost:3000)** (or `http://127.0.0.1:3000`).

---

## 🌐 Secure Internet Access via Cloudflare Tunnel

To make this dashboard accessible over the internet while Oracle XE runs safely on your local PC:

1. **Never port-forward port 1521 or port 3000 on your router.**
2. Install **Cloudflare Tunnel (`cloudflared`)**:
   ```bash
   winget install Cloudflare.cloudflared
   ```
3. Run a quick temporary tunnel:
   ```bash
   cloudflared tunnel --url http://127.0.0.1:3000
   ```
4. Or configure a named production tunnel in the Cloudflare Zero Trust Dashboard:
   - **Service Type**: `HTTP`
   - **URL**: `127.0.0.1:3000`
   - In `.env`, set:
     ```env
     COOKIE_SECURE=true
     ALLOWED_ORIGINS=https://powerplant.yourdomain.com
     ```
5. All traffic will be encrypted end-to-end via Cloudflare's edge network with DDoS mitigation and SSL, while Oracle and Node.js remain strictly bound to your local machine!

---

## 🧪 Automated Security & Verification Suite

An automated verification test suite is included in [`test_security_suite.js`](file:///c:/Users/viran/OneDrive%20-%20vit.ac.in/Desktop/PowerPlant_Assessment/test_security_suite.js).

To execute the tests:
```bash
node test_security_suite.js
```

### Verified Test Cases:
| Test | Objective | Status |
| :--- | :--- | :--- |
| **Test 1** | Generic `/api/health` without secret disclosures | **PASSED** |
| **Test 2** | Unauthorized API rejection (401 without session) | **PASSED** |
| **Test 3** | CSRF Token enforcement (403 without token) | **PASSED** |
| **Test 4** | Session cookie & CSRF token retrieval | **PASSED** |
| **Test 5** | Sanitized error handling for invalid credentials (ORA-01017) | **PASSED** |
| **Test 6** | Real Oracle XE ODBC authentication (`PowerPlantDSN`) | **PASSED** |
| **Test 7** | Live relational database table query | **PASSED** |
| **Test 8** | Complete multi-user session isolation | **PASSED** |
| **Test 9** | Administrator arbitrary SQL execution | **PASSED** |
| **Test 10** | Session termination / Logout revocation | **PASSED** |

---

## 💾 Database Backup & Export

1. **Schema Script**: [`powerplant.sql`](file:///c:/Users/viran/OneDrive%20-%20vit.ac.in/Desktop/PowerPlant_Assessment/powerplant.sql) contains the complete DDL structure.
2. **Web GUI Export**: Navigate to the **Catalog & DDL** tab and click **Export Oracle SQL Dump** to download a timestamped `.sql` backup containing all active rows and table structures.
3. **Oracle Command-Line Export (Data Pump)**:
   ```cmd
   expdp powerplant/powerplant DIRECTORY=DATA_PUMP_DIR DUMPFILE=powerplant_backup.dmp SCHEMAS=powerplant
   ```

---

## 📁 Summary of Modified Files

- [`server.js`](file:///c:/Users/viran/OneDrive%20-%20vit.ac.in/Desktop/PowerPlant_Assessment/server.js): Rewritten with Helmet security headers, per-user session isolation (`express-session`), CSRF verification, rate limiting, role-based authorization, generic error handling, and `127.0.0.1` binding.
- [`app.js`](file:///c:/Users/viran/OneDrive%20-%20vit.ac.in/Desktop/PowerPlant_Assessment/app.js): Updated to send `X-CSRF-Token` headers, use strict same-origin API routes, display user roles (`Administrator` vs `Operator`), and handle session timeouts.
- [`index.html`](file:///c:/Users/viran/OneDrive%20-%20vit.ac.in/Desktop/PowerPlant_Assessment/index.html): Added `return false;` form submission guard to prevent unintended full-page reloads.
- [`package.json`](file:///c:/Users/viran/OneDrive%20-%20vit.ac.in/Desktop/PowerPlant_Assessment/package.json): Added `express-session`, `helmet`, `express-rate-limit`, `dotenv`.
- [`.env.example`](file:///c:/Users/viran/OneDrive%20-%20vit.ac.in/Desktop/PowerPlant_Assessment/.env.example): Template for production secrets and configuration.
- [`.env`](file:///c:/Users/viran/OneDrive%20-%20vit.ac.in/Desktop/PowerPlant_Assessment/.env): Local secret configuration (excluded from Git).
- [`.gitignore`](file:///c:/Users/viran/OneDrive%20-%20vit.ac.in/Desktop/PowerPlant_Assessment/.gitignore): Excludes `.env`, `node_modules`, logs, binaries (`*.exe`, `*.dll`).
- [`test_security_suite.js`](file:///c:/Users/viran/OneDrive%20-%20vit.ac.in/Desktop/PowerPlant_Assessment/test_security_suite.js): Comprehensive end-to-end security and ODBC verification test suite.
