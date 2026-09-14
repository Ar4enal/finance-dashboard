# -*- coding: utf-8 -*-
"""
持仓数据「自动导出」模块（v34 需求5）。

需求：默认每天 06:00 自动把全部持仓数据导出到本地；导出时间可在「数据导入 / 导出」
模块中配置；错过的时刻在下次启动时补导一次。

设计（沿用项目既有后台任务 intraday_track 的线程模型）：

- **触发机制**：后端守护线程每 TICK_INTERVAL(30) 秒轮询一次，判断「今天是否已导出」
  与「当前时间是否已达配置时刻」；已到点且今天未导出 → 执行一次导出。
  · 服务未运行时不触发；**服务启动后若「今天已过配置时刻且今天尚未导出」→ 立即补导一次**
    （reason=startup_catchup），其余为 reason=scheduled。
- **时间格式**：配置值 `"HH:MM"`（24 小时制），默认 `"06:00"`。前端用 `<input type="time">` 采集，
  后端 `_normalize_time()` 再规整一次（兼容 `H:MM` / `HH:MM:SS`，非法值回退默认）。
- **存储位置**：`<项目根>/data/auto_export/`（`data/` 已在 .gitignore 中 —— 导出文件含持仓明细，
  不会被误提交到公开仓库）。
- **文件命名**：`持仓数据_YYYY-MM-DD.json`（每天一份；同一天内重复触发会覆盖当天文件）。
- **保留策略**：默认保留最近 30 份（按文件名倒序即日期倒序），超出的自动删除；
  **只处理本模块生成的文件**（前缀 `持仓数据_` + 后缀 `.json`），绝不触碰根目录的手动导出文件。
- **与手动导出的关系**：自动导出**不修改**项目根目录的 `持仓数据_export.json`，
  两者内容同源（都调用 `db.export_all_data()`）但互不干扰。

数据真实性：导出内容完全来自本地数据库的真实数据，不生成任何虚拟值。
"""
import os
import json
import time
import threading
from datetime import datetime

from . import database as db

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT_DIR = os.path.join(BASE_DIR, "data", "auto_export")

FILE_PREFIX = "持仓数据_"
FILE_SUFFIX = ".json"

SET_ENABLED = "auto_export_enabled"
SET_TIME = "auto_export_time"
SET_KEEP = "auto_export_keep"
SET_LAST_RUN = "auto_export_last_run"
SET_LAST_DATE = "auto_export_last_date"

DEFAULT_TIME = "06:00"
DEFAULT_KEEP = 30
TICK_INTERVAL = 30          # 轮询间隔（秒）

_lock = threading.Lock()
_thread = None
_stop = False
_first_tick = True


# ---------------------------------------------------------------
# 配置
# ---------------------------------------------------------------
def _normalize_time(t):
    """把用户输入规整为 HH:MM（24 小时制）；非法输入回退默认值。"""
    if not t or not isinstance(t, str):
        return DEFAULT_TIME
    parts = t.strip().split(":")
    try:
        hh = int(parts[0])
        mm = int(parts[1]) if len(parts) > 1 else 0
    except Exception:
        return DEFAULT_TIME
    if not (0 <= hh <= 23) or not (0 <= mm <= 59):
        return DEFAULT_TIME
    return "%02d:%02d" % (hh, mm)


def get_config():
    enabled = (db.get_setting(SET_ENABLED, "1") or "1") == "1"
    t = _normalize_time(db.get_setting(SET_TIME, DEFAULT_TIME))
    try:
        keep = int(db.get_setting(SET_KEEP, str(DEFAULT_KEEP)) or DEFAULT_KEEP)
    except Exception:
        keep = DEFAULT_KEEP
    if keep <= 0:
        keep = DEFAULT_KEEP
    return {"enabled": enabled, "time": t, "keep": keep}


def save_config(enabled=None, time_str=None, keep=None):
    if enabled is not None:
        db.set_setting(SET_ENABLED, "1" if enabled else "0")
    if time_str is not None:
        db.set_setting(SET_TIME, _normalize_time(time_str))
    if keep is not None:
        try:
            k = int(keep)
            db.set_setting(SET_KEEP, str(k if k > 0 else DEFAULT_KEEP))
        except Exception:
            pass
    return get_config()


# ---------------------------------------------------------------
# 文件
# ---------------------------------------------------------------
def _ensure_dir():
    os.makedirs(EXPORT_DIR, exist_ok=True)
    return EXPORT_DIR


def list_files():
    """列出自动导出文件，最新的在前（文件名即日期，倒序排列）。"""
    _ensure_dir()
    out = []
    try:
        for fn in os.listdir(EXPORT_DIR):
            if fn.startswith(FILE_PREFIX) and fn.endswith(FILE_SUFFIX):
                p = os.path.join(EXPORT_DIR, fn)
                if os.path.isfile(p):
                    st = os.stat(p)
                    out.append({
                        "name": fn,
                        "path": p,
                        "size": st.st_size,
                        "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                    })
    except Exception:
        pass
    out.sort(key=lambda x: x["name"], reverse=True)
    return out


def run_export(reason="manual"):
    """执行一次导出。返回 {ok, file, path, size, at, removed, reason, total}。"""
    with _lock:
        _ensure_dir()
        payload = db.export_all_data()          # 与手动导出完全同源
        now = datetime.now()
        fname = FILE_PREFIX + now.strftime("%Y-%m-%d") + FILE_SUFFIX
        fpath = os.path.join(EXPORT_DIR, fname)
        text = json.dumps(payload, ensure_ascii=False, indent=2)
        with open(fpath, "w", encoding="utf-8") as f:
            f.write(text)

        # 超出保留份数的旧文件自动清理（仅限本模块生成的文件）
        keep = get_config()["keep"]
        files = list_files()
        removed = []
        if keep > 0 and len(files) > keep:
            for it in files[keep:]:
                try:
                    os.remove(it["path"])
                    removed.append(it["name"])
                except Exception:
                    pass

        at = now.strftime("%Y-%m-%d %H:%M:%S")
        db.set_setting(SET_LAST_RUN, at)
        db.set_setting(SET_LAST_DATE, now.strftime("%Y-%m-%d"))
        return {
            "ok": True,
            "file": fname,
            "path": fpath,
            "size": len(text.encode("utf-8")),
            "at": at,
            "removed": removed,
            "reason": reason,
            "total": len(list_files()),
        }


# ---------------------------------------------------------------
# 调度
# ---------------------------------------------------------------
def _due():
    """返回 (是否应导出, 原因)。已到点且今天未导出 → (True, 'startup_catchup'/'scheduled')。"""
    cfg = get_config()
    if not cfg["enabled"]:
        return False, ""
    now = datetime.now()
    if (db.get_setting(SET_LAST_DATE, "") or "") == now.strftime("%Y-%m-%d"):
        return False, ""                        # 今天已导出过
    hh, mm = [int(x) for x in cfg["time"].split(":")]
    if now < now.replace(hour=hh, minute=mm, second=0, microsecond=0):
        return False, ""                        # 还没到点
    return True, ("startup_catchup" if _first_tick else "scheduled")


def _loop():
    global _first_tick
    while not _stop:
        try:
            need, why = _due()
            if need:
                run_export(reason=why)
        except Exception:
            pass                                # 后台任务不得因异常中断
        _first_tick = False
        time.sleep(TICK_INTERVAL)


def start():
    """启动后台调度线程（幂等）。"""
    global _thread, _stop
    if _thread is not None and _thread.is_alive():
        return False
    _stop = False
    _thread = threading.Thread(target=_loop, daemon=True, name="auto-export")
    _thread.start()
    return True


def stop():
    global _stop
    _stop = True


def info():
    """聚合返回给前端的状态（配置 + 存储位置 + 最近导出 + 文件列表）。"""
    cfg = get_config()
    files = list_files()
    return {
        "enabled": cfg["enabled"],
        "time": cfg["time"],
        "keep": cfg["keep"],
        "dir": EXPORT_DIR,
        "dir_display": "data/auto_export/",
        "name_pattern": FILE_PREFIX + "YYYY-MM-DD" + FILE_SUFFIX,
        "last_run": db.get_setting(SET_LAST_RUN, "") or "",
        "last_date": db.get_setting(SET_LAST_DATE, "") or "",
        "count": len(files),
        "files": files[:10],                    # 最近 10 份
    }
