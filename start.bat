@echo off
setlocal
title Power Plant Management System - Backend & Web GUI
cls

echo ===================================================================
echo   ⚡ GRIDPULSE - POWER PLANT MANAGEMENT SYSTEM (ORACLE ODBC)
echo   Relational DBMS & Oracle XE Assessment Dashboard
echo ===================================================================
echo.

:: 1. Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js runtime was not found in your PATH.
    echo.
    echo Node.js is required to run the backend API server and ODBC bridge.
    echo Please install Node.js (v18, v20, or v22 LTS) on this lab computer:
    echo https://nodejs.org/
    echo.
    echo If Node.js is installed in a custom location, add it to your PATH.
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js detected:
node -v
npm -v
echo.

:: 2. Check dependencies (install only if node_modules is missing)
if not exist node_modules (
    echo [INFO] First-time setup: Installing required dependencies (express, cors, odbc)...
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo.
        echo [ERROR] npm install encountered an error. Please check your internet or permissions.
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed successfully.
    echo.
) else (
    echo [OK] Dependencies already installed (node_modules present).
)

:: 3. Startup information
echo [INFO] Starting Backend Server on http://localhost:3000 ...
echo [INFO] Health check available at: http://localhost:3000/api/health
echo [INFO] Opening Web Dashboard in default browser...
echo.

:: Open browser after a brief delay
start "" "http://localhost:3000"

:: 4. Start the server directly (keeps terminal open to display logs and errors)
node server.js

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] The backend server stopped unexpectedly with code %ERRORLEVEL%.
    echo Please inspect the error output above.
    pause
)

endlocal
