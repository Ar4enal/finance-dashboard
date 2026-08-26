@echo off
chcp 65001 >nul 2>&1
REM ============================================================
REM 金融工作台 - Windows 环境配置脚本 (Python 3.7+)
REM ------------------------------------------------------------
REM 作用：
REM   1. 检测 Python（python 或 py）
REM   2. 创建虚拟环境 .venv
REM   3. 安装 Python 3.7 兼容的最小依赖（fastapi + uvicorn + requests）
REM   4. 检测 node 并构建前端（有 node 则 build，无则跳过，用交付的 frontend_dist）
REM   5. 校验启动所需文件
REM 用法：双击运行，或命令行执行 setup_env.bat
REM 可重复执行（幂等），不污染系统 Python
REM ============================================================

setlocal
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

echo.
echo ==============================================
echo   金融工作台 · Windows 环境配置开始
echo ==============================================

REM ---------- 1. 定位 Python ----------
set "PYTHON_CMD="
where python >nul 2>&1 && set "PYTHON_CMD=python"
if not defined PYTHON_CMD (
    where py >nul 2>&1 && set "PYTHON_CMD=py"
)
if not defined PYTHON_CMD (
    echo [FAIL] 未找到 Python，请先安装 Python 3.7+ 并勾选 "Add Python to PATH"
    echo        下载地址：https://www.python.org/downloads/
    goto :end
)

REM ---------- 2. 检测 Python 版本 ----------
echo [setup] 检测 Python 版本...
%PYTHON_CMD% -c "import sys; v=sys.version_info; exit(0 if v[0]==3 and v[1]>=7 else 1)"
if errorlevel 1 (
    echo [FAIL] 需要 Python 3.7 及以上版本，请升级 Python
    goto :end
)
for /f "delims=" %%v in ('%PYTHON_CMD% -c "import sys; print('%%d.%%d' %% sys.version_info[:2])"') do set "PY_VERSION=%%v"
echo [ OK  ] 当前 Python 版本：%PY_VERSION%

REM ---------- 3. 检测 pip ----------
echo [setup] 检测 pip...
%PYTHON_CMD% -m pip --version >nul 2>&1
if errorlevel 1 (
    echo [WARN] 未检测到 pip，尝试引导安装...
    %PYTHON_CMD% -m ensurepip --upgrade >nul 2>&1
    if errorlevel 1 (
        echo [FAIL] pip 安装失败，请手动运行: %PYTHON_CMD% -m ensurepip --upgrade
        goto :end
    )
)

REM ---------- 4. 创建虚拟环境 ----------
set "VENV_DIR=%SCRIPT_DIR%.venv"
if exist "%VENV_DIR%\Scripts\python.exe" (
    echo [ OK  ] 虚拟环境已存在，跳过创建
) else (
    echo [setup] 创建虚拟环境...
    %PYTHON_CMD% -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [FAIL] 虚拟环境创建失败，请检查 Python 安装完整性
        goto :end
    )
    echo [ OK  ] 虚拟环境创建成功
)

set "VENV_PY=%VENV_DIR%\Scripts\python.exe"
if not exist "%VENV_PY%" (
    echo [FAIL] 未找到虚拟环境 Python，请删除 .venv 文件夹后重试
    goto :end
)

REM 兜底：若 venv 内 pip 模块不可用，用 ensurepip 修复
%VENV_PY% -m pip --version >nul 2>&1
if errorlevel 1 (
    echo [WARN] 虚拟环境缺少 pip 模块，尝试修复...
    %VENV_PY% -m ensurepip --upgrade >nul 2>&1
    if errorlevel 1 (
        echo [FAIL] pip 修复失败，请删除 .venv 后重新运行本脚本
        goto :end
    )
)

REM ---------- 5. 升级 pip 并安装依赖 ----------
echo [setup] 升级 pip / setuptools / wheel...
%VENV_PY% -m pip install --upgrade pip setuptools wheel >nul 2>&1

if not exist "%SCRIPT_DIR%requirements.txt" (
    echo [FAIL] 未找到 requirements.txt
    goto :end
)
echo [setup] 安装后端依赖（Python %PY_VERSION% 兼容版）...
%VENV_PY% -m pip install -r "%SCRIPT_DIR%requirements.txt"
if errorlevel 1 (
    echo [setup] 官方源失败，尝试清华镜像源...
    %VENV_PY% -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r "%SCRIPT_DIR%requirements.txt"
    if errorlevel 1 (
        echo [FAIL] 依赖安装失败，请检查网络后重试
        goto :end
    )
)

REM ---------- 6. 验证后端依赖 ----------
echo [setup] 验证后端依赖...
%VENV_PY% -c "import fastapi, uvicorn, requests; print('  fastapi', fastapi.__version__)"
if errorlevel 1 (
    echo [FAIL] 后端依赖验证失败
    goto :end
)
echo [ OK  ] 后端依赖验证通过

REM ---------- 7. 前端构建（检测 node） ----------
echo [setup] 检测 node 环境...
where node >nul 2>&1
if errorlevel 1 (
    echo [WARN] 未检测到 node，跳过前端构建。
    echo [WARN] 将使用交付的 frontend_dist 构建产物（已含，开箱即用）。
) else (
    if exist "%SCRIPT_DIR%frontend\package.json" (
        echo [ OK  ] 检测到 node，构建前端（需联网下载依赖，较慢）...
        pushd "%SCRIPT_DIR%frontend"
        call npm install >nul 2>&1
        call npm run build
        popd
        if exist "%SCRIPT_DIR%frontend_dist\index.html" (
            echo [ OK  ] 前端构建产物已生成
        ) else (
            echo [WARN] 前端构建未生成产物，将使用交付的 frontend_dist
        )
    )
)

REM ---------- 8. 校验前端产物 ----------
if exist "%SCRIPT_DIR%frontend_dist\index.html" (
    echo [ OK  ] 前端产物就绪: frontend_dist\index.html
) else (
    echo [WARN] 未找到 frontend_dist 构建产物，请先构建前端或从交付包恢复
)

REM ---------- 9. 完成 ----------
echo.
echo ==============================================
echo   环境配置完成！
echo ==============================================
echo.
echo   启动应用：双击 operation.bat
echo   浏览器访问：http://localhost:8000
echo   局域网访问：http://本机局域网IP:8000（见 operation.bat 启动输出）
echo.
echo   若出现中文乱码，请在 Windows 设置中开启
echo   "使用 Unicode UTF-8 提供全球语言支持"
echo.

:end
pause
endlocal
