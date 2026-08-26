#!/usr/bin/env bash
# ============================================================
# 金融工作台 - 环境配置脚本 (Python 3.7 / Linux)
# ------------------------------------------------------------
# 作用：
#   1. 检测/补装 venv 支持（缺失时自动安装）
#   2. 创建虚拟环境 .venv
#   3. 安装 Python 3.7 兼容的最小依赖（fastapi + uvicorn + requests）
#   4. 检测 node 并构建前端（有 node 则 build，无则用前端预览版兜底）
#   5. 生成启动脚本
# 用法：bash setup_env.sh
# 可重复执行（幂等），不污染系统 Python
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
PYTHON_CMD="python3"

COLOR_RESET="\033[0m"; COLOR_GREEN="\033[32m"; COLOR_YELLOW="\033[33m"
COLOR_RED="\033[31m"; COLOR_CYAN="\033[36m"

info()  { echo -e "${COLOR_CYAN}[setup]${COLOR_RESET} $*"; }
ok()    { echo -e "${COLOR_GREEN}[  OK  ]${COLOR_RESET} $*"; }
warn()  { echo -e "${COLOR_YELLOW}[ WARN ]${COLOR_RESET} $*"; }
fail()  { echo -e "${COLOR_RED}[ FAIL ]${COLOR_RESET} $*"; exit 1; }

echo
info "=============================================="
info " 金融工作台 · 环境配置开始"
info "=============================================="

# ---------- 1. 检测 Python 版本 ----------
info "检测 Python 版本..."
if ! command -v "$PYTHON_CMD" >/dev/null 2>&1; then
    fail "未找到 python3，请先安装 Python 3.7+"
fi

PY_MAJOR=$("$PYTHON_CMD" -c 'import sys; print(sys.version_info[0])')
PY_MINOR=$("$PYTHON_CMD" -c 'import sys; print(sys.version_info[1])')
PY_VERSION=$("$PYTHON_CMD" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
info "当前 Python 版本：$PY_VERSION"

if [ "$PY_MAJOR" -ne 3 ]; then fail "需要 Python 3，当前是 $PY_MAJOR"; fi
if [ "$PY_MINOR" -lt 7 ]; then fail "需要 Python 3.7 及以上，当前是 $PY_VERSION"; fi

# ---------- 2. 检测 pip ----------
info "检测 pip..."
if ! "$PYTHON_CMD" -m pip --version >/dev/null 2>&1; then
    warn "未检测到 pip，尝试引导安装..."
    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update
        sudo apt-get install -y python3-pip || "$PYTHON_CMD" -m ensurepip || fail "pip 安装失败"
    else
        "$PYTHON_CMD" -m ensurepip --upgrade || fail "pip 安装失败"
    fi
fi
ok "pip 可用：$("$PYTHON_CMD" -m pip --version)"

# ---------- 3. 检测/补装 venv ----------
info "检测 venv 支持..."
USE_VIRTUALENV=0
if ! "$PYTHON_CMD" -c "import venv" >/dev/null 2>&1; then
    warn "缺少 venv 模块，尝试补装..."
    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update
        sudo apt-get install -y python3-venv || true
    fi
    if ! "$PYTHON_CMD" -c "import venv" >/dev/null 2>&1; then
        info "python3-venv 未生效，改用 virtualenv 方案..."
        "$PYTHON_CMD" -m pip install --user virtualenv || fail "无法安装 virtualenv"
        USE_VIRTUALENV=1
    fi
fi

# ---------- 4. 创建虚拟环境 ----------
if [ -d "$VENV_DIR" ] && [ -x "$VENV_DIR/bin/python" ]; then
    ok "虚拟环境已存在，跳过创建：$VENV_DIR"
else
    info "创建虚拟环境：$VENV_DIR"
    if [ "$USE_VIRTUALENV" = "1" ]; then
        "$PYTHON_CMD" -m virtualenv "$VENV_DIR"
    else
        "$PYTHON_CMD" -m venv "$VENV_DIR"
    fi
    ok "虚拟环境创建成功"
fi

VENV_PY="$VENV_DIR/bin/python"
# 注意：某些系统（尤其 Python 3.7）的 venv 不生成独立的 .venv/bin/pip 文件，
# 因此统一用 "$VENV_PY -m pip" 方式调用 pip，最可靠。

# 兜底：若 venv 内 pip 模块不可用（残缺环境），提示重建
if ! "$VENV_PY" -m pip --version >/dev/null 2>&1; then
    warn "虚拟环境缺少 pip 模块（可能创建不完整）。"
    warn "尝试用 ensurepip 修复..."
    if ! "$VENV_PY" -m ensurepip --upgrade >/dev/null 2>&1; then
        warn "自动修复失败，请手动删除 .venv 后重试："
        fail "rm -rf .venv && bash setup_env.sh"
    fi
fi

# ---------- 5. 升级 pip & 安装依赖 ----------
info "升级 pip / setuptools / wheel..."
"$VENV_PY" -m pip install --upgrade pip setuptools wheel 2>/dev/null || warn "升级失败（可忽略）"

if [ ! -f "$SCRIPT_DIR/requirements.txt" ]; then
    fail "未找到 requirements.txt"
fi
info "安装后端依赖（Python $PY_VERSION 兼容版）..."
"$VENV_PY" -m pip install -r "$SCRIPT_DIR/requirements.txt" \
    || "$VENV_PY" -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r "$SCRIPT_DIR/requirements.txt" \
    || fail "依赖安装失败，请检查网络"

# ---------- 6. 验证后端依赖 ----------
info "验证后端依赖..."
"$VENV_PY" -c "import fastapi, uvicorn, requests; print('  fastapi', fastapi.__version__)" \
    && ok "后端依赖验证通过" || fail "后端依赖验证失败"

# ---------- 7. 前端构建（检测 node） ----------
info "检测 node 环境..."
if command -v node >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
    ok "检测到 node + pnpm，构建前端..."
    if [ -d "$SCRIPT_DIR/frontend" ]; then
        (cd "$SCRIPT_DIR/frontend" && pnpm install && pnpm build) || warn "前端构建失败（可稍后手动重试）"
        [ -d "$SCRIPT_DIR/frontend_dist" ] && ok "前端构建产物已生成" || warn "前端构建产物缺失，将使用预览版兜底"
    fi
elif command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    ok "检测到 node + npm，构建前端..."
    if [ -d "$SCRIPT_DIR/frontend" ]; then
        (cd "$SCRIPT_DIR/frontend" && npm install && npm run build) || warn "前端构建失败"
        [ -d "$SCRIPT_DIR/frontend_dist" ] && ok "前端构建产物已生成" || warn "前端构建产物缺失"
    fi
else
    warn "未检测到 node，跳过前端构建。"
    warn "若希望使用 React 版前端，请安装 node + npm 后运行: (cd frontend && npm install && npm run build)"
    warn "当前将以纯 HTML 预览版作为前端（可用但功能有限）"
fi

# ---------- 8. 生成启停脚本（幂等：仅当 operation.sh 缺失时才生成） ----------
if [ -f "$SCRIPT_DIR/operation.sh" ]; then
    ok "启停脚本已存在，保留现有 operation.sh（含局域网访问支持）"
else
    cat > "$SCRIPT_DIR/operation.sh" <<EOF
#!/usr/bin/env bash
# 金融工作台 - 一键启动
SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
PORT="\${1:-8000}"
HOST="\${2:-0.0.0.0}"
if [ ! -x "\$SCRIPT_DIR/.venv/bin/uvicorn" ]; then
    echo "[start] 未找到虚拟环境，请先运行: bash setup_env.sh"
    exit 1
fi
echo "[start] 启动金融工作台 → http://localhost:\$PORT  (Ctrl+C 停止)"
exec "\$SCRIPT_DIR/.venv/bin/uvicorn" app.main:app --host "\$HOST" --port "\$PORT" --app-dir "\$SCRIPT_DIR"
EOF
    chmod +x "$SCRIPT_DIR/operation.sh"
    ok "启停脚本已生成：bash operation.sh"
fi

# ---------- 9. 完成 ----------
echo
info "=============================================="
info " 环境配置完成！"
info "=============================================="
echo
echo "  启动应用：bash operation.sh"
echo "  浏览器访问：http://localhost:8000"
echo "  自定义端口：bash operation.sh 9000"
echo
