@echo off
chcp 65001 >nul 2>&1
REM ============================================================
REM Finance Dashboard - Windows environment setup script (Python 3.7-3.12)
REM ------------------------------------------------------------
REM What it does:
REM   1. Detect Python (python or py)
REM   2. Create virtual environment .venv
REM   3. Install Python 3.7-3.12 compatible minimal deps (fastapi + uvicorn + requests)
REM   4. Detect node and build frontend (build if node present, else skip using delivered frontend_dist)
REM   5. Verify required files
REM Usage: double-click to run, or: setup_env.bat
REM Idempotent. Does not pollute system Python.
REM ============================================================

setlocal
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

echo.
echo ==============================================
echo   Finance Dashboard - Windows setup start
echo ==============================================

REM ---------- 1. Locate Python (prefer a 3.7-3.12 interpreter) ----------
set "PYTHON_CMD="
REM Prefer py launcher with an explicit compatible version (avoids Python 3.13)
for %%m in (3.12 3.11 3.10 3.9 3.8 3.7) do (
    if not defined PYTHON_CMD (
        py -%%m --version >nul 2>&1 && set "PYTHON_CMD=py -%%m"
    )
)
if not defined PYTHON_CMD (
    where python >nul 2>&1 && set "PYTHON_CMD=python"
)
if not defined PYTHON_CMD (
    where py >nul 2>&1 && set "PYTHON_CMD=py"
)
if not defined PYTHON_CMD (
    echo [FAIL] Python not found. Install Python 3.7-3.12 and tick "Add Python to PATH".
    echo        Download: https://www.python.org/downloads/
    goto :end
)

REM ---------- 2. Check Python version (require 3.7-3.12) ----------
echo [setup] Checking Python version...
%PYTHON_CMD% -c "import sys; v=sys.version_info; exit(0 if v[0]==3 and 7<=v[1]<=12 else 1)"
if errorlevel 1 (
    for /f "delims=" %%v in ('%PYTHON_CMD% -c "import sys; print('%%d.%%d' %% sys.version_info[:2])"') do set "PY_VERSION=%%v"
    echo [FAIL] Python %PY_VERSION% is not supported.
    echo        This project pins fastapi 0.99.1 + pydantic 1.10 (v1), which is
    echo        incompatible with Python 3.13+. Please install Python 3.7-3.12
    echo        (recommended 3.12) and re-run setup_env.bat.
    echo        Download: https://www.python.org/downloads/
    goto :end
)
for /f "delims=" %%v in ('%PYTHON_CMD% -c "import sys; print('%%d.%%d' %% sys.version_info[:2])"') do set "PY_VERSION=%%v"
echo [ OK  ] Python version: %PY_VERSION%

REM ---------- 3. Detect pip ----------
echo [setup] Checking pip...
%PYTHON_CMD% -m pip --version >nul 2>&1
if errorlevel 1 (
    echo [WARN] pip not detected, trying to bootstrap...
    %PYTHON_CMD% -m ensurepip --upgrade >nul 2>&1
    if errorlevel 1 (
        echo [FAIL] pip bootstrap failed. Run manually: %PYTHON_CMD% -m ensurepip --upgrade
        goto :end
    )
)

REM ---------- 4. Create virtual environment ----------
set "VENV_DIR=%SCRIPT_DIR%.venv"
if exist "%VENV_DIR%\Scripts\python.exe" (
    echo [ OK  ] Virtual environment already exists, skip creation
) else (
    echo [setup] Creating virtual environment...
    %PYTHON_CMD% -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [FAIL] Virtual environment creation failed. Check Python install integrity.
        goto :end
    )
    echo [ OK  ] Virtual environment created
)

set "VENV_PY=%VENV_DIR%\Scripts\python.exe"
if not exist "%VENV_PY%" (
    echo [FAIL] Virtual environment Python not found. Delete .venv and retry.
    goto :end
)

REM Fallback: repair pip inside venv if missing
%VENV_PY% -m pip --version >nul 2>&1
if errorlevel 1 (
    echo [WARN] venv missing pip module, trying to repair...
    %VENV_PY% -m ensurepip --upgrade >nul 2>&1
    if errorlevel 1 (
        echo [FAIL] pip repair failed. Delete .venv and re-run this script.
        goto :end
    )
)

REM ---------- 5. Upgrade pip and install dependencies ----------
echo [setup] Upgrading pip / setuptools / wheel...
%VENV_PY% -m pip install --upgrade pip setuptools wheel >nul 2>&1

if not exist "%SCRIPT_DIR%requirements.txt" (
    echo [FAIL] requirements.txt not found
    goto :end
)
echo [setup] Installing backend dependencies (Python %PY_VERSION% compatible)...
%VENV_PY% -m pip install -r "%SCRIPT_DIR%requirements.txt"
if errorlevel 1 (
    echo [setup] Official index failed, trying Tsinghua mirror...
    %VENV_PY% -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r "%SCRIPT_DIR%requirements.txt"
    if errorlevel 1 (
        echo [FAIL] Dependency install failed. Check network and retry.
        goto :end
    )
)

REM ---------- 6. Verify backend dependencies ----------
echo [setup] Verifying backend dependencies...
%VENV_PY% -c "import fastapi, uvicorn, requests; print('  fastapi', fastapi.__version__)"
if errorlevel 1 (
    echo [FAIL] Backend dependency verification failed
    goto :end
)
echo [ OK  ] Backend dependencies verified

REM ---------- 7. Frontend build (detect node) ----------
echo [setup] Checking node environment...
where node >nul 2>&1
if errorlevel 1 (
    echo [WARN] node not detected, skip frontend build.
    echo [WARN] Will use delivered frontend_dist build artifact (included, ready to use).
) else (
    if exist "%SCRIPT_DIR%frontend\package.json" (
        echo [ OK  ] node detected, building frontend (needs network for deps, slower)...
        pushd "%SCRIPT_DIR%frontend"
        call npm install >nul 2>&1
        call npm run build
        popd
        if exist "%SCRIPT_DIR%frontend_dist\index.html" (
            echo [ OK  ] Frontend build artifact generated
        ) else (
            echo [WARN] Frontend build produced no output, will use delivered frontend_dist
        )
    )
)

REM ---------- 8. Verify frontend artifact ----------
if exist "%SCRIPT_DIR%frontend_dist\index.html" (
    echo [ OK  ] Frontend artifact ready: frontend_dist\index.html
) else (
    echo [WARN] frontend_dist build artifact not found. Build frontend or restore from delivered package.
)

REM ---------- 9. Done ----------
echo.
echo ==============================================
echo   Environment setup complete!
echo ==============================================
echo.
echo   Start app:    double-click operation.bat
echo   Browser:      http://localhost:8000
echo   LAN access:   http://<this-machine-LAN-IP>:8000 (see operation.bat startup output)
echo.

:end
pause
endlocal
