@echo off
chcp 65001 >nul 2>&1
REM Force UTF-8 mode so the running app reads/writes Chinese financial data (e.g. HK positions) correctly
set PYTHONUTF8=1
REM ============================================================
REM Finance Dashboard - Windows one-click start/stop script
REM ------------------------------------------------------------
REM Usage:
REM   operation.bat            Start (default port 8000, host 0.0.0.0 for LAN)
REM   operation.bat 9000       Start on port 9000
REM   operation.bat stop       Stop the backend
REM   operation.bat restart    Restart
REM   operation.bat status     Show running status
REM ============================================================

setlocal
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

set "PID_FILE=%SCRIPT_DIR%.server.pid"
set "LOG_FILE=%SCRIPT_DIR%.server.log"
set "CMD=%~1"
set "PORT=%~2"
if "%PORT%"=="" set "PORT=8000"
set "HOST=0.0.0.0"

REM ---------- Get LAN IP ----------
for /f "delims=" %%i in ('powershell -NoProfile -Command "$p=Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object {$_.IPv4DefaultGateway -ne $null} | Select-Object -First 1; if($p){$p.IPv4Address.IPAddress}else{""}"') do set "LAN_IP=%%i"
if "%LAN_IP%"=="" (
    for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.IPAddress -ne "127.0.0.1"} | Select-Object -First 1).IPAddress"') do set "LAN_IP=%%i"
)
if "%LAN_IP%"=="" set "LAN_IP=127.0.0.1"

REM ---------- Check if process is running ----------
:check_running
set "RUNNING=0"
if exist "%PID_FILE%" (
    set /p OLD_PID=<"%PID_FILE%"
    if defined OLD_PID (
        tasklist /FI "PID eq %OLD_PID%" 2>nul | findstr /B "%OLD_PID%" >nul 2>&1
        if not errorlevel 1 set "RUNNING=1"
    )
)

if /i "%CMD%"=="stop" goto :stop
if /i "%CMD%"=="restart" goto :stop
if /i "%CMD%"=="status" goto :status

REM ---------- Start ----------
:start
if "%RUNNING%"=="1" (
    echo [start] Backend already running PID %OLD_PID%. No need to start again.
    echo [start] Local:    http://localhost:%PORT%
    echo [start] LAN:      http://%LAN_IP%:%PORT% open in a browser on the same network
    goto :end
)
if not exist "%SCRIPT_DIR%.venv\Scripts\python.exe" (
    echo [start] Virtual environment not found. Run setup_env.bat first.
    goto :end
)
echo [start] Starting Finance Dashboard (listening on %HOST%:%PORT%)...
start "FinanceDashboard Backend" /B cmd /c ""%SCRIPT_DIR%.venv\Scripts\python.exe" -m uvicorn app.main:app --host %HOST% --port %PORT% --app-dir "%SCRIPT_DIR%" >"%LOG_FILE%" 2>&1"

REM Wait and write PID (find the python process listening on the port)
set "NEW_PID="
for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"') do set "NEW_PID=%%i"
if not defined NEW_PID set "NEW_PID="
echo %NEW_PID%> "%PID_FILE%"
timeout /t 1 /nobreak >nul 2>&1

if exist "%LOG_FILE%" (
    echo [start] Started. Log file: %LOG_FILE%
) else (
    echo [start] Starting, please wait and refresh
)
echo [start] Local:    http://localhost:%PORT%
if "%HOST%"=="0.0.0.0" (
    echo [start] LAN:      http://%LAN_IP%:%PORT% open in a browser on the same network
)
echo [start] To stop:  double-click operation.bat stop, or run: operation.bat stop
goto :end

REM ---------- Stop ----------
:stop
if "%RUNNING%"=="1" (
    echo [stop] Stopping backend PID %OLD_PID%...
    taskkill /PID %OLD_PID% /F >nul 2>&1
    REM Kill by port to avoid killing other python programs
    for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"') do (
        if not "%%i"=="" taskkill /PID %%i /F >nul 2>&1
    )
    del "%PID_FILE%" >nul 2>&1
    echo [stop] Backend stopped.
) else (
    del "%PID_FILE%" >nul 2>&1
    echo [stop] Backend is not running.
)
if /i "%CMD%"=="stop" goto :end
REM For restart, continue to start
if not "%CMD%"=="restart" goto :end
goto :start

REM ---------- Status ----------
:status
if "%RUNNING%"=="1" (
    echo [status] Running PID %OLD_PID%
    echo [status] Local:    http://localhost:%PORT%
    echo [status] LAN:      http://%LAN_IP%:%PORT%
) else (
    echo [status] Not running
)
goto :end

:end
echo.
pause
endlocal
