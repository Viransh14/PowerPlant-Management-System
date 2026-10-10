#include <windows.h>
#include <sql.h>
#include <sqlext.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

SQLHENV env = SQL_NULL_HENV;
SQLHDBC dbc = SQL_NULL_HDBC;

typedef struct {
    const char *title, *table, *cols[4], *types, *search;
    int n;
} Entity;

Entity entities[] = {
    {"Power Plants", "POWER_PLANT",
     {"PLANT_ID","PLANT_NAME","LOCATION","CAPACITY_MW"},
     "NTTN","PLANT_NAME",4},
    {"Generators", "GENERATOR",
     {"GENERATOR_ID","PLANT_ID","GENERATOR_NAME","STATUS"},
     "NNTT","GENERATOR_NAME",4},
    {"Employees", "EMPLOYEE",
     {"EMPLOYEE_ID","EMPLOYEE_NAME","ROLE","PLANT_ID"},
     "NTTN","EMPLOYEE_NAME",4},
    {"Generation Records", "GENERATION_RECORD",
     {"RECORD_ID","PLANT_ID","GENERATION_DATE","UNITS_GENERATED"},
     "NNDN","PLANT_ID",4}
};

static int succeeded(SQLRETURN r) {
    return r == SQL_SUCCESS || r == SQL_SUCCESS_WITH_INFO;
}

static void showError(SQLSMALLINT type, SQLHANDLE handle) {
    SQLCHAR state[6] = "", message[512] = "";
    SQLINTEGER native = 0;
    SQLSMALLINT length = 0;
    if (handle != SQL_NULL_HANDLE &&
        SQL_SUCCEEDED(SQLGetDiagRec(type, handle, 1, state, &native,
                                   message, sizeof(message), &length))) {
        printf("\nODBC error [%s]: %s\n", state, message);
    }
}

static void readLine(const char *prompt, char *out, size_t size) {
    printf("%s: ", prompt);
    if (!fgets(out, (int)size, stdin)) {
        out[0] = '\0';
        return;
    }
    out[strcspn(out, "\r\n")] = '\0';
}

static int readChoice(void) {
    char s[32];
    readLine("Choice", s, sizeof(s));
    return atoi(s);
}

static void waitEnter(void) {
    char line[8];
    printf("\nPress Enter to continue...");
    fgets(line, sizeof(line), stdin);
}

static int connectDB(void) {
    char dsn[128], user[128], pass[128];

    if (!succeeded(SQLAllocHandle(SQL_HANDLE_ENV, SQL_NULL_HANDLE, &env)))
        return 0;
    if (!succeeded(SQLSetEnvAttr(env, SQL_ATTR_ODBC_VERSION,
                                 (SQLPOINTER)SQL_OV_ODBC3, 0)))
        return 0;
    if (!succeeded(SQLAllocHandle(SQL_HANDLE_DBC, env, &dbc)))
        return 0;

    printf("Power Plant Management System - ODBC Login\n");
    readLine("ODBC DSN name (e.g. LabOracle)", dsn, sizeof(dsn));
    readLine("Oracle username", user, sizeof(user));
    readLine("Oracle password", pass, sizeof(pass));

    SQLRETURN r = SQLConnect(dbc,
        (SQLCHAR *)dsn, SQL_NTS,
        (SQLCHAR *)user, SQL_NTS,
        (SQLCHAR *)pass, SQL_NTS);

    /* Clear the password buffer as soon as the connection attempt finishes. */
    memset(pass, 0, sizeof(pass));

    if (!succeeded(r)) {
        showError(SQL_HANDLE_DBC, dbc);
        return 0;
    }

    SQLSetConnectAttr(dbc, SQL_ATTR_AUTOCOMMIT,
                      (SQLPOINTER)SQL_AUTOCOMMIT_ON, 0);
    printf("\nConnected to Oracle through ODBC.\n");
    return 1;
}

static void disconnectDB(void) {
    if (dbc != SQL_NULL_HDBC) {
        SQLDisconnect(dbc);
        SQLFreeHandle(SQL_HANDLE_DBC, dbc);
        dbc = SQL_NULL_HDBC;
    }
    if (env != SQL_NULL_HENV) {
        SQLFreeHandle(SQL_HANDLE_ENV, env);
        env = SQL_NULL_HENV;
    }
}

static int executePrepared(const char *sql, char values[][256], int count,
                           SQLLEN *affected) {
    SQLHSTMT st = SQL_NULL_HSTMT;
    SQLRETURN r;
    SQLLEN lengths[10];

    if (!succeeded(SQLAllocHandle(SQL_HANDLE_STMT, dbc, &st)))
        return 0;

    r = SQLPrepare(st, (SQLCHAR *)sql, SQL_NTS);
    if (!succeeded(r)) {
        showError(SQL_HANDLE_STMT, st);
        SQLFreeHandle(SQL_HANDLE_STMT, st);
        return 0;
    }

    for (int i = 0; i < count; ++i) {
        lengths[i] = SQL_NTS;
        r = SQLBindParameter(st, (SQLUSMALLINT)(i + 1), SQL_PARAM_INPUT,
                             SQL_C_CHAR, SQL_VARCHAR, 255, 0,
                             values[i], sizeof(values[i]), &lengths[i]);
        if (!succeeded(r)) {
            showError(SQL_HANDLE_STMT, st);
            SQLFreeHandle(SQL_HANDLE_STMT, st);
            return 0;
        }
    }

    r = SQLExecute(st);
    if (!succeeded(r)) {
        showError(SQL_HANDLE_STMT, st);
        SQLFreeHandle(SQL_HANDLE_STMT, st);
        return 0;
    }

    if (affected) SQLRowCount(st, affected);
    SQLFreeHandle(SQL_HANDLE_STMT, st);
    return 1;
}

static void executeSQL(const char *sql) {
    SQLHSTMT st = SQL_NULL_HSTMT;
    if (!succeeded(SQLAllocHandle(SQL_HANDLE_STMT, dbc, &st))) return;
    SQLRETURN r = SQLExecDirect(st, (SQLCHAR *)sql, SQL_NTS);
    if (!succeeded(r)) showError(SQL_HANDLE_STMT, st);
    else printf("SQL command executed successfully.\n");
    SQLFreeHandle(SQL_HANDLE_STMT, st);
}

static void showQuery(const char *sql) {
    SQLHSTMT st = SQL_NULL_HSTMT;
    SQLRETURN r;
    SQLSMALLINT ncols = 0;

    if (!succeeded(SQLAllocHandle(SQL_HANDLE_STMT, dbc, &st))) return;
    r = SQLExecDirect(st, (SQLCHAR *)sql, SQL_NTS);
    if (!succeeded(r)) {
        showError(SQL_HANDLE_STMT, st);
        SQLFreeHandle(SQL_HANDLE_STMT, st);
        return;
    }

    SQLNumResultCols(st, &ncols);
    for (SQLSMALLINT c = 1; c <= ncols; ++c) {
        SQLCHAR name[128] = "";
        SQLSMALLINT len = 0, type = 0, scale = 0, nullable = 0;
        SQLULEN size = 0;
        SQLDescribeCol(st, c, name, sizeof(name), &len, &type,
                       &size, &scale, &nullable);
        printf("%-22.22s", name);
    }
    printf("\n");
    for (SQLSMALLINT c = 0; c < ncols; ++c) printf("----------------------");
    printf("\n");

    while ((r = SQLFetch(st)) != SQL_NO_DATA) {
        if (!SQL_SUCCEEDED(r)) {
            showError(SQL_HANDLE_STMT, st);
            break;
        }
        for (SQLSMALLINT c = 1; c <= ncols; ++c) {
            SQLCHAR value[256] = "";
            SQLLEN indicator = 0;
            r = SQLGetData(st, c, SQL_C_CHAR, value, sizeof(value), &indicator);
            if (indicator == SQL_NULL_DATA) printf("%-22s", "NULL");
            else if (SQL_SUCCEEDED(r)) printf("%-22.22s", value);
            else printf("%-22s", "[read error]");
        }
        printf("\n");
    }
    SQLFreeHandle(SQL_HANDLE_STMT, st);
}

static void listRecords(Entity *e) {
    char sql[768] = "SELECT ";
    for (int i = 0; i < e->n; ++i) {
        if (i) strcat(sql, ", ");
        if (strcmp(e->cols[i], "GENERATION_DATE") == 0) {
            strcat(sql, "TO_CHAR(GENERATION_DATE, 'YYYY-MM-DD') AS GENERATION_DATE");
        } else strcat(sql, e->cols[i]);
    }
    strcat(sql, " FROM ");
    strcat(sql, e->table);
    strcat(sql, " ORDER BY ");
    strcat(sql, e->cols[0]);
    showQuery(sql);
}

static void insertRecord(Entity *e) {
    char values[10][256] = {{0}};
    char sql[1024] = "";
    SQLLEN affected = 0;

    strcat(sql, "INSERT INTO ");
    strcat(sql, e->table);
    strcat(sql, " (");
    for (int i = 0; i < e->n; ++i) {
        if (i) strcat(sql, ", ");
        strcat(sql, e->cols[i]);
        readLine(e->cols[i], values[i], sizeof(values[i]));
    }
    strcat(sql, ") VALUES (");
    for (int i = 0; i < e->n; ++i) {
        if (i) strcat(sql, ", ");
        if (e->types[i] == 'N') strcat(sql, "TO_NUMBER(?)");
        else if (e->types[i] == 'D') strcat(sql, "TO_DATE(?, 'YYYY-MM-DD')");
        else strcat(sql, "?");
    }
    strcat(sql, ")");

    if (executePrepared(sql, values, e->n, &affected))
        printf("Insert executed. Rows affected: %ld\n", (long)affected);
}

static void updateRecord(Entity *e) {
    char input[10][256] = {{0}}, params[10][256] = {{0}};
    char sql[1024] = "";
    SQLLEN affected = 0;

    readLine("ID of record to update", input[0], sizeof(input[0]));
    strcat(sql, "UPDATE ");
    strcat(sql, e->table);
    strcat(sql, " SET ");

    for (int i = 1; i < e->n; ++i) {
        if (i > 1) strcat(sql, ", ");
        strcat(sql, e->cols[i]);
        strcat(sql, " = ");
        if (e->types[i] == 'N') strcat(sql, "TO_NUMBER(?)");
        else if (e->types[i] == 'D') strcat(sql, "TO_DATE(?, 'YYYY-MM-DD')");
        else strcat(sql, "?");
        readLine(e->cols[i], input[i], sizeof(input[i]));
        strcpy(params[i - 1], input[i]);
    }
    strcat(sql, " WHERE ");
    strcat(sql, e->cols[0]);
    strcat(sql, " = TO_NUMBER(?)");
    strcpy(params[e->n - 1], input[0]);

    if (executePrepared(sql, params, e->n, &affected))
        printf("Update executed. Rows affected: %ld\n", (long)affected);
}

static void deleteRecord(Entity *e) {
    char values[10][256] = {{0}}, sql[256];
    SQLLEN affected = 0;
    readLine("ID to delete", values[0], sizeof(values[0]));
    snprintf(sql, sizeof(sql), "DELETE FROM %s WHERE %s = TO_NUMBER(?)",
             e->table, e->cols[0]);

    if (executePrepared(sql, values, 1, &affected))
        printf("Delete executed. Rows affected: %ld\n", (long)affected);
}

static void searchRecords(Entity *e) {
    char value[10][256] = {{0}}, sql[512];
    SQLHSTMT st = SQL_NULL_HSTMT;
    SQLRETURN r;
    SQLLEN length = SQL_NTS;
    SQLSMALLINT ncols = 0;

    readLine("Search text (partial match)", value[0], sizeof(value[0]));
    snprintf(sql, sizeof(sql),
        "SELECT * FROM %s WHERE UPPER(TO_CHAR(%s)) LIKE '%%' || UPPER(?) || '%%'",
        e->table, e->search);

    if (!succeeded(SQLAllocHandle(SQL_HANDLE_STMT, dbc, &st))) return;
    r = SQLPrepare(st, (SQLCHAR *)sql, SQL_NTS);
    if (succeeded(r))
        r = SQLBindParameter(st, 1, SQL_PARAM_INPUT, SQL_C_CHAR,
                             SQL_VARCHAR, 255, 0, value[0],
                             sizeof(value[0]), &length);
    if (succeeded(r)) r = SQLExecute(st);

    if (!succeeded(r)) {
        showError(SQL_HANDLE_STMT, st);
        SQLFreeHandle(SQL_HANDLE_STMT, st);
        return;
    }

    SQLNumResultCols(st, &ncols);
    for (SQLSMALLINT c = 1; c <= ncols; ++c) {
        SQLCHAR name[128] = "";
        SQLSMALLINT len = 0, type = 0, scale = 0, nullable = 0;
        SQLULEN size = 0;
        SQLDescribeCol(st, c, name, sizeof(name), &len, &type,
                       &size, &scale, &nullable);
        printf("%-22.22s", name);
    }
    printf("\n");
    while ((r = SQLFetch(st)) != SQL_NO_DATA) {
        if (!SQL_SUCCEEDED(r)) break;
        for (SQLSMALLINT c = 1; c <= ncols; ++c) {
            SQLCHAR v[256] = "";
            SQLLEN ind = 0;
            SQLGetData(st, c, SQL_C_CHAR, v, sizeof(v), &ind);
            printf("%-22.22s", ind == SQL_NULL_DATA ? "NULL" : (char *)v);
        }
        printf("\n");
    }
    SQLFreeHandle(SQL_HANDLE_STMT, st);
}

static void ddlMenu(void) {
    printf("\n--- DDL Demonstrations ---\n");
    printf("1. CREATE MAINTENANCE_LOG table\n");
    printf("2. ALTER MAINTENANCE_LOG: add NOTES column\n");
    printf("3. View project table structure\n");
    printf("0. Back\n");

    switch (readChoice()) {
    case 1:
        executeSQL("CREATE TABLE MAINTENANCE_LOG ("
                   "LOG_ID NUMBER PRIMARY KEY, "
                   "PLANT_ID NUMBER REFERENCES POWER_PLANT(PLANT_ID), "
                   "MAINTENANCE_DATE DATE, DESCRIPTION VARCHAR2(300), COST NUMBER)");
        break;
    case 2:
        executeSQL("ALTER TABLE MAINTENANCE_LOG ADD (NOTES VARCHAR2(200))");
        break;
    case 3:
        showQuery("SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE "
                  "FROM USER_TAB_COLUMNS WHERE TABLE_NAME IN "
                  "('POWER_PLANT','GENERATOR','EMPLOYEE',"
                  "'GENERATION_RECORD','MAINTENANCE_LOG') "
                  "ORDER BY TABLE_NAME, COLUMN_ID");
        break;
    default:
        break;
    }
}

static void reportsMenu(void) {
    printf("\n--- Reports / DQL Queries ---\n");
    printf("1. Plant-wise generation report (JOIN, GROUP BY, SUM)\n");
    printf("2. Plants ordered by capacity\n");
    printf("3. Employee count per plant\n");
    printf("4. View all plants\n");
    printf("0. Back\n");

    switch (readChoice()) {
    case 1:
        showQuery("SELECT p.PLANT_NAME, p.CAPACITY_MW, "
                  "NVL(SUM(g.UNITS_GENERATED),0) TOTAL_UNITS, "
                  "COUNT(g.RECORD_ID) RECORD_COUNT "
                  "FROM POWER_PLANT p LEFT JOIN GENERATION_RECORD g "
                  "ON p.PLANT_ID=g.PLANT_ID "
                  "GROUP BY p.PLANT_NAME,p.CAPACITY_MW "
                  "ORDER BY TOTAL_UNITS DESC");
        break;
    case 2:
        showQuery("SELECT PLANT_ID, PLANT_NAME, CAPACITY_MW "
                  "FROM POWER_PLANT ORDER BY CAPACITY_MW DESC");
        break;
    case 3:
        showQuery("SELECT p.PLANT_NAME, COUNT(e.EMPLOYEE_ID) EMPLOYEE_COUNT "
                  "FROM POWER_PLANT p LEFT JOIN EMPLOYEE e "
                  "ON p.PLANT_ID=e.PLANT_ID "
                  "GROUP BY p.PLANT_NAME ORDER BY p.PLANT_NAME");
        break;
    case 4:
        listRecords(&entities[0]);
        break;
    default:
        break;
    }
}

int main(void) {
    if (!connectDB()) {
        printf("\nConnection failed. Check DSN, username, password, and Oracle service.\n");
        disconnectDB();
        return 1;
    }

    for (;;) {
        printf("\n===== POWER PLANT MANAGEMENT =====\n");
        printf("1. Power Plants (CRUD)\n");
        printf("2. Generators (CRUD)\n");
        printf("3. Employees (CRUD)\n");
        printf("4. Generation Records (CRUD)\n");
        printf("5. Reports / DQL queries\n");
        printf("6. DDL demonstrations\n");
        printf("0. Exit\n");

        int choice = readChoice();
        if (choice == 0) break;
        if (choice == 5) { reportsMenu(); waitEnter(); continue; }
        if (choice == 6) { ddlMenu(); waitEnter(); continue; }
        if (choice < 1 || choice > 4) {
            printf("Invalid choice.\n");
            continue;
        }

        Entity *e = &entities[choice - 1];
        printf("\n--- %s ---\n", e->title);
        printf("1. Add record (INSERT)\n");
        printf("2. View records (SELECT)\n");
        printf("3. Search records (WHERE / LIKE)\n");
        printf("4. Update record (UPDATE)\n");
        printf("5. Delete record (DELETE)\n");
        printf("0. Back\n");

        switch (readChoice()) {
        case 1: insertRecord(e); break;
        case 2: listRecords(e); break;
        case 3: searchRecords(e); break;
        case 4: updateRecord(e); break;
        case 5: deleteRecord(e); break;
        default: break;
        }
        waitEnter();
    }

    disconnectDB();
    printf("Disconnected. Goodbye.\n");
    return 0;
}
