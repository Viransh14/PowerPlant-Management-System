@echo off
setlocal
echo Building Power Plant Management System...
gcc main.c -o powerplant.exe -lodbc32
if errorlevel 1 (
    echo.
    echo BUILD FAILED. Check that GCC, Windows ODBC headers, and the
    echo ODBC library are installed and that compiler architecture matches.
    pause
    exit /b 1
)
echo.
echo Build successful. Run powerplant.exe to start the application.
pause
