@echo off
chcp 65001 >nul 2>&1
REM ============================================================
REM 金融工作台 - Windows 一键启停脚本
REM ------------------------------------------------------------
REM 用法：
REM   operation.bat           启动（默认端口 8000，监听 0.0.0.0 可局域网访问）
REM   operation.bat 9000      启动，指定端口 9000
REM   operation.bat stop      停止后端
REM   operation.bat restart   重启
REM   operation.bat status    查看运行状态
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

REM ---------- 获取局域网 IP ----------
for /f "delims=" %%i in ('powershell -NoProfile -Command "$p=Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object {$_.IPv4DefaultGateway -ne $null} | Select-Object -First 1; if($p){$p.IPv4Address.IPAddress}else{''}"') do set "LAN_IP=%%i"
if "%LAN_IP%"=="" (
    for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.IPAddress -ne '127.0.0.1'} | Select-Object -First 1).IPAddress"') do set "LAN_IP=%%i"
)
if "%LAN_IP%"=="" set "LAN_IP=127.0.0.1"

REM ---------- 判定进程是否运行 ----------
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

REM ---------- 启动 ----------
:start
if "%RUNNING%"=="1" (
    echo [start] 后端已在运行 (PID %OLD_PID%)，无需重复启动。
    echo [start] 本机访问 → http://localhost:%PORT%
    echo [start] 局域网访问 → http://%LAN_IP%:%PORT% （同一局域网内其他终端浏览器打开）
    goto :end
)
if not exist "%SCRIPT_DIR%.venv\Scripts\python.exe" (
    echo [start] 未找到虚拟环境，请先运行: setup_env.bat
    goto :end
)
echo [start] 正在启动金融工作台（监听 %HOST%:%PORT%）...
start "金融工作台后端" /B cmd /c ""%SCRIPT_DIR%.venv\Scripts\python.exe" -m uvicorn app.main:app --host %HOST% --port %PORT% --app-dir "%SCRIPT_DIR%" >"%LOG_FILE%" 2>&1"

REM 等待并写入 PID（找到监听端口的 python 进程）
set "NEW_PID="
for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"') do set "NEW_PID=%%i"
if not defined NEW_PID set "NEW_PID="
echo %NEW_PID%> "%PID_FILE%"
timeout /t 1 /nobreak >nul 2>&1

if exist "%LOG_FILE%" (
    echo [start] 启动成功，日志: %LOG_FILE%
) else (
    echo [start] 启动中，请稍后访问
)
echo [start] 本机访问 → http://localhost:%PORT%
if "%HOST%"=="0.0.0.0" (
    echo [start] 局域网访问 → http://%LAN_IP%:%PORT% （同一局域网内其他终端设备浏览器打开）
)
echo [start] 停止服务：双击 operation.bat stop 或运行: operation.bat stop
goto :end

REM ---------- 停止 ----------
:stop
if "%RUNNING%"=="1" (
    echo [stop] 正在停止后端 (PID %OLD_PID%)...
    taskkill /PID %OLD_PID% /F >nul 2>&1
    REM 通过端口查找占用进程并结束（避免误杀其他 Python 程序）
    for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"') do (
        if not "%%i"=="" taskkill /PID %%i /F >nul 2>&1
    )
    del "%PID_FILE%" >nul 2>&1
    echo [stop] 后端已停止。
) else (
    del "%PID_FILE%" >nul 2>&1
    echo [stop] 后端当前未运行。
)
if /i "%CMD%"=="stop" goto :end
REM restart 则继续启动
if not "%CMD%"=="restart" goto :end
goto :start

REM ---------- 状态 ----------
:status
if "%RUNNING%"=="1" (
    echo [status] 运行中 (PID %OLD_PID%)
    echo [status] 本机访问 → http://localhost:%PORT%
    echo [status] 局域网访问 → http://%LAN_IP%:%PORT%
) else (
    echo [status] 未运行
)
goto :end

:end
echo.
pause
endlocal
