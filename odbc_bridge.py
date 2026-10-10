import sys
import json
from datetime import date, datetime

def serialize_val(val):
    if isinstance(val, (date, datetime)):
        return val.strftime('%Y-%m-%d')
    elif isinstance(val, bytes):
        return val.decode('utf-8', errors='ignore')
    elif isinstance(val, (int, float, str)):
        return val
    elif val is None:
        return None
    return str(val)

def clean_error_msg(err_str, dsn=""):
    clean = str(err_str).replace("\x00", "").strip()
    if "ORA-01017" in clean:
        return "Oracle Logon Denied (ORA-01017): Invalid username or password."
    if "IM002" in clean:
        return f"ODBC DSN Not Found (IM002): Data source '{dsn}' is not configured in Windows ODBC Administrator."
    if "ORA-12541" in clean:
        return "Oracle TNS Listener is not running (ORA-12541)."
    if "ORA-01034" in clean:
        return "Oracle instance is currently not available (ORA-01034)."
    return clean

def main():
    try:
        import pyodbc
    except ImportError:
        print(json.dumps({"success": False, "error": "Python pyodbc module is not installed."}))
        return

    try:
        raw_input = sys.stdin.read()
        if not raw_input:
            print(json.dumps({"success": False, "error": "No input provided to ODBC bridge"}))
            return

        req = json.loads(raw_input)
        dsn = req.get("dsn", "").strip()
        user = req.get("user", "").strip()
        password = req.get("password", "")
        action = req.get("action", "query")

        if not dsn or not user:
            print(json.dumps({"success": False, "error": "DSN and Username are required"}))
            return

        conn_str = f"DSN={dsn};UID={user};PWD={password}"
        conn = None
        try:
            conn = pyodbc.connect(conn_str, autocommit=True)
            cursor = conn.cursor()

            if action == "test_connect":
                cursor.execute("SELECT 1 FROM DUAL")
                row = cursor.fetchone()
                print(json.dumps({
                    "success": True,
                    "message": f"Successfully connected to Oracle via DSN [{dsn}] as user [{user}].",
                    "dsn": dsn,
                    "user": user
                }))
                return

            elif action == "fetch_all":
                result = {
                    "success": True,
                    "POWER_PLANT": [],
                    "GENERATOR": [],
                    "EMPLOYEE": [],
                    "GENERATION_RECORD": [],
                    "MAINTENANCE_LOG": [],
                    "hasMaintenanceTable": False,
                    "hasMaintenanceNotes": False
                }

                # 1. POWER_PLANT
                try:
                    cursor.execute("SELECT PLANT_ID, PLANT_NAME, LOCATION, CAPACITY_MW FROM POWER_PLANT ORDER BY PLANT_ID")
                    cols = [c[0] for c in cursor.description]
                    for r in cursor.fetchall():
                        result["POWER_PLANT"].append({cols[i]: serialize_val(r[i]) for i in range(len(cols))})
                except Exception as e:
                    result["powerPlantError"] = clean_error_msg(e, dsn)

                # 2. GENERATOR
                try:
                    cursor.execute("SELECT GENERATOR_ID, PLANT_ID, GENERATOR_NAME, STATUS FROM GENERATOR ORDER BY GENERATOR_ID")
                    cols = [c[0] for c in cursor.description]
                    for r in cursor.fetchall():
                        result["GENERATOR"].append({cols[i]: serialize_val(r[i]) for i in range(len(cols))})
                except Exception as e:
                    result["generatorError"] = clean_error_msg(e, dsn)

                # 3. EMPLOYEE
                try:
                    cursor.execute("SELECT EMPLOYEE_ID, EMPLOYEE_NAME, ROLE, PLANT_ID FROM EMPLOYEE ORDER BY EMPLOYEE_ID")
                    cols = [c[0] for c in cursor.description]
                    for r in cursor.fetchall():
                        result["EMPLOYEE"].append({cols[i]: serialize_val(r[i]) for i in range(len(cols))})
                except Exception as e:
                    result["employeeError"] = clean_error_msg(e, dsn)

                # 4. GENERATION_RECORD
                try:
                    cursor.execute("SELECT RECORD_ID, PLANT_ID, TO_CHAR(GENERATION_DATE, 'YYYY-MM-DD') AS GENERATION_DATE, UNITS_GENERATED FROM GENERATION_RECORD ORDER BY RECORD_ID")
                    cols = [c[0] for c in cursor.description]
                    for r in cursor.fetchall():
                        result["GENERATION_RECORD"].append({cols[i]: serialize_val(r[i]) for i in range(len(cols))})
                except Exception as e:
                    result["recordError"] = clean_error_msg(e, dsn)

                # 5. MAINTENANCE_LOG check
                try:
                    cursor.execute("SELECT COLUMN_NAME FROM USER_TAB_COLUMNS WHERE TABLE_NAME = 'MAINTENANCE_LOG'")
                    m_cols = [row[0] for row in cursor.fetchall()]
                    if m_cols:
                        result["hasMaintenanceTable"] = True
                        result["hasMaintenanceNotes"] = "NOTES" in m_cols
                        cursor.execute("SELECT LOG_ID, PLANT_ID, TO_CHAR(MAINTENANCE_DATE, 'YYYY-MM-DD') AS MAINTENANCE_DATE, DESCRIPTION, COST" + (", NOTES" if "NOTES" in m_cols else "") + " FROM MAINTENANCE_LOG ORDER BY LOG_ID")
                        cols = [c[0] for c in cursor.description]
                        for r in cursor.fetchall():
                            result["MAINTENANCE_LOG"].append({cols[i]: serialize_val(r[i]) for i in range(len(cols))})
                except Exception as e:
                    result["maintenanceError"] = clean_error_msg(e, dsn)

                print(json.dumps(result))
                return

            elif action == "execute_sql":
                sql = req.get("sql", "").strip()
                params = req.get("params", [])

                if params:
                    cursor.execute(sql, params)
                else:
                    cursor.execute(sql)

                if cursor.description:
                    columns = [col[0] for col in cursor.description]
                    rows = []
                    for r in cursor.fetchall():
                        row_dict = {}
                        for idx, val in enumerate(r):
                            row_dict[columns[idx]] = serialize_val(val)
                        rows.append(row_dict)
                    print(json.dumps({"success": True, "columns": columns, "rows": rows, "rowCount": len(rows)}))
                    return
                else:
                    rowcount = cursor.rowcount
                    print(json.dumps({"success": True, "columns": ["STATUS"], "rows": [{"STATUS": f"Statement executed successfully. Rows affected: {rowcount}"}], "rowCount": rowcount}))
                    return

            elif action == "execute_script":
                statements = req.get("statements", [])
                results = []
                for stmt in statements:
                    stmt_clean = stmt.strip().rstrip(';')
                    if not stmt_clean:
                        continue
                    try:
                        cursor.execute(stmt_clean)
                        results.append({"sql": stmt_clean, "success": True})
                    except Exception as ex:
                        results.append({"sql": stmt_clean, "success": False, "error": clean_error_msg(ex, dsn)})
                print(json.dumps({"success": True, "results": results}))
                return

        finally:
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass

    except Exception as e:
        print(json.dumps({"success": False, "error": clean_error_msg(e, dsn if 'dsn' in locals() else "")}))

if __name__ == "__main__":
    main()
