@echo off
chcp 65001 >nul 2>&1
REM Force UTF-8 mode so the running app reads/writes Chinese financial data (e.g. HK positions) correctly
set PYTHONUTF8=1
REM ============================================================
REM Finance Dashboard - Windows control script (mirrors operation.sh)
REM ------------------------------------------------------------
REM Usage (run from cmd / PowerShell):
REM   operation.bat            start (default port 8000, host 0.0.0.0 for LAN)
REM   operation.bat start [port]
REM   operation.bat stop
REM   operation.bat restart [port]
REM   operation.bat status
REM The backend runs as a DETACHED hidden process, so closing this
REM window will NOT stop it (same behaviour as Linux nohup).
REM ============================================================

setlocal
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

set "PID_FILE=%SCRIPT_DIR%.server.pid"
set "LOG_FILE=%SCRIPT_DIR%.server.log"
set "CMD=%~1"
if "%CMD%"=="" set "CMD=start"
set "PORT=%~2"
if "%PORT%"=="" set "PORT=8000"
set "HOST=0.0.0.0"

REM ---------- Get LAN IP ----------
for /f "delims=" %%i in ('powershell -NoProfile -Command "$p=Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object {$_.IPv4DefaultGateway -ne $null} | Select-Object -First 1; if($p){$p.IPv4Address.IPAddress}else{""}"') do set "LAN_IP=%%i"
if "%LAN_IP%"=="" (
    for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.IPAddress -ne "127.0.0.1"} | Select-Object -First 1).IPAddress"') do set "LAN_IP=%%i"
)
if "%LAN_IP%"=="" set "LAN_IP=127.0.0.1"

REM ---------- Determine running state by port (authoritative) ----------
REM We use the listening port as the source of truth instead of the PID file,
REM because capturing the detached child PID reliably on Windows is fragile.
:check_running
set "RUN_PID="
set "RUNNING=0"
for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"') do ( set "RUN_PID=%%i" )
if defined RUN_PID set "RUNNING=1"

if /i "%CMD%"=="stop" goto :stop
if /i "%CMD%"=="restart" goto :stop
if /i "%CMD%"=="status" goto :status

REM ---------- Start (detached, hidden, survives window close) ----------
:start
if "%RUNNING%"=="1" (
    echo [start] Backend already running [PID %RUN_PID%] on port %PORT%. No need to start again.
    echo [start] Local:    http://localhost:%PORT%
    echo [start] LAN:      http://%LAN_IP%:%PORT% open in a browser on the same network
    goto :end
)
if not exist "%SCRIPT_DIR%.venv\Scripts\python.exe" (
    echo [start] Virtual environment not found. Run setup_env.bat first.
    goto :end
)

REM Clear any leftover listener on the port (a zombie from a previously
REM detached process would otherwise cause "address already in use").
for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"') do (
    if not "%%i"=="" (
        echo [start] Port %PORT% occupied by leftover PID %%i, clearing...
        taskkill /PID %%i /F >nul 2>&1
        timeout /t 1 /nobreak >nul 2>&1
    )
)

echo [start] Starting Finance Dashboard (listening on %HOST%:%PORT%)...

REM Launch backend as a fully DETACHED hidden process so it keeps running
REM after this window is closed (same behaviour as Linux nohup). uvicorn writes
REM timestamped logs to .server.log via logging_config.json; app tracebacks go
REM to .server.err. Port listening is used to confirm the start, not the PID.
powershell -NoProfile -Command "Start-Process -FilePath '%SCRIPT_DIR%.venv\Scripts\python.exe' -ArgumentList '-m','uvicorn','app.main:app','--host','%HOST%','--port','%PORT%','--app-dir','%SCRIPT_DIR%','--log-config','%SCRIPT_DIR%logging_config.json','--log-level','info' -WorkingDirectory '%SCRIPT_DIR%' -WindowStyle Hidden -RedirectStandardError '%SCRIPT_DIR%.server.err'"

REM Wait until the port is actually listening (robust liveness check).
REM Use a labelled loop (no goto inside parentheses) to avoid cmd parse pitfalls.
set "UP=0"
set "TRY=0"
:waitloop
set /a TRY+=1
powershell -NoProfile -Command "if(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue){exit 0}else{exit 1}" >nul 2>&1
if not errorlevel 1 (
    set "UP=1"
    goto :started
)
if %TRY% GEQ 20 goto :starteddone
timeout /t 1 /nobreak >nul 2>&1
goto :waitloop
:starteddone
if "%UP%"=="0" (
    echo [start] Start failed, please check log: %LOG_FILE%
    goto :end
)

:started
REM Best-effort: record the listening PID for reference (not used for liveness)
set "START_PID="
for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"') do (
    set "START_PID=%%i"
    echo %%i > "%PID_FILE%"
)
echo [start] Started [PID %START_PID%]. Log: %LOG_FILE%
echo [start] Local:    http://localhost:%PORT%
if "%HOST%"=="0.0.0.0" (
    echo [start] LAN:      http://%LAN_IP%:%PORT% open in a browser on the same network
)
echo [start] To stop:  operation.bat stop
goto :end

REM ---------- Stop ----------
:stop
if "%RUNNING%"=="1" (
    echo [stop] Stopping backend on port %PORT% [PID %RUN_PID%]...
    taskkill /PID %RUN_PID% /F >nul 2>&1
) else (
    echo [stop] Backend is not running on port %PORT%.
)
REM Always clear by port too, so no zombie listener is left behind
for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"') do (
    if not "%%i"=="" taskkill /PID %%i /F >nul 2>&1
)
del "%PID_FILE%" >nul 2>&1
if "%RUNNING%"=="1" echo [stop] Backend stopped.
if /i "%CMD%"=="stop" goto :end
REM For restart, continue to start
if not "%CMD%"=="restart" goto :end
goto :start

REM ---------- Status ----------
:status
if "%RUNNING%"=="1" (
    echo [status] Running [PID %RUN_PID%] on port %PORT%
    echo [status] Local:    http://localhost:%PORT%
    echo [status] LAN:      http://%LAN_IP%:%PORT%
) else (
    echo [status] Not running
)
goto :end

:end
endlocal
