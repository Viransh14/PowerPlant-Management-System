POWER PLANT MANAGEMENT - C + ODBC + ORACLE XE
================================================

FILES
-----
main.c          Menu-driven C application using Windows ODBC API
powerplant.sql  Oracle schema creation script
build.bat       Compiles main.c with GCC and Windows ODBC library
README.txt      These instructions

IMPORTANT: LAB CONNECTION
-------------------------
The application asks for the ODBC DSN name, Oracle username and password
when it starts. It does not hardcode your home credentials.

Your lab details were described as:
  username: 25BCE1371
  service:  ORCL
  password: your provided lab password

Usually, the @ORCL part identifies the Oracle service, not part of the
username. Confirm this with your lab's SQL*Plus setup. Do not assume the
DSN is automatically named ORCL: configure an ODBC DSN on the lab PC and
enter that exact DSN name when prompted.

LAB STEPS
---------
1. Log in to SQL*Plus with the lab account.
2. Run SHOW USER; and SELECT table_name FROM user_tables;
3. If the four project tables already exist, do NOT run powerplant.sql.
4. If they do not exist and your account is allowed to create tables,
   run powerplant.sql in SQL*Plus.
5. Open ODBC Data Source Administrator. Check for an Oracle ODBC driver.
   WIN+R then odbcad32.exe..
6. Create a System DSN (for example, LabOracle) pointing to the correct
   Oracle service. Test it if the driver offers a test button.
7. Copy this folder to the lab PC.
8. Ensure GCC and its ODBC headers are installed and match the driver's
   32-bit/64-bit architecture.
9. Open Command Prompt in this folder and run build.bat.
10. Run powerplant.exe and enter the DSN, username, and password.

BUILD
-----
The build command is:
  gcc main.c -o powerplant.exe -lodbc32

If GCC is not available, ask the lab staff which C compiler and ODBC
development headers are approved. Do not rely only on an executable built
on a different computer.

MENU
----
Power Plants: add, view, search, update, delete
Generators: add, view, search, update, delete
Employees: add, view, search, update, delete
Generation Records: add, view, search, update, delete
Reports: JOIN, GROUP BY, SUM, COUNT, ORDER BY
DDL: CREATE MAINTENANCE_LOG, ALTER TABLE to add NOTES, inspect columns

DATA TYPES / INPUTS
-------------------
For date input, use YYYY-MM-DD.
For numeric IDs and numeric fields, enter digits only.
When inserting a child record (generator, employee, generation record),
its PLANT_ID must refer to an existing plant.

NOTES
-----
- Do not share your Oracle password or put it in source code.
- The app's DDL demo can return an error if you repeat CREATE TABLE or
  ALTER TABLE for an object that already exists. That is expected.
- The app is intended for a local classroom assessment, not public hosting.
