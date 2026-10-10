@echo off
setlocal
title Power Plant Management System - Backend & Web GUI
cls

echo ===================================================================
echo   ⚡ GRIDPULSE - POWER PLANT MANAGEMENT SYSTEM (ORACLE ODBC)
echo   Relational DBMS & Oracle XE Assessment Dashboard
echo ===================================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js runtime was not found in your PATH.
    echo Node.js is required to run the Express backend server and Oracle ODBC bridge.
    echo Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if not exist node_modules (
    echo [INFO] Installing required dependencies...
    call npm install
)

start "" "http://localhost:3000"
node server.js

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] The backend server stopped unexpectedly with code %ERRORLEVEL%.
    pause
)

endlocal
