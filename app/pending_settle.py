# -*- coding: utf-8 -*-
"""待确认交易的基金净值回填后台线程（v36）。

背景
----
录入场外基金买入/卖出时，若该基金在「净值对应交易日」的官方净值尚未公布
（基金净值通常于交易日收盘后当晚更新，QDII 可能再延迟 1～2 个交易日），
此前会直接拦截用户提交。现在改为：**先把交易以「待确认」状态落库，
净值公布后由本模块自动回填价格**，回填完成后该笔交易才计入持仓份额与成本。

工作方式
--------
- **仅在存在待确认交易时才发起请求**：先 `db.get_pending_transactions()` 判断，
  无待确认交易则整轮不做任何网络请求（空转）；
- 只处理「净值对应交易日 ≤ 今天」的交易，未到来的先跳过（避免无谓请求）；
- 逐笔用 `ds.fund_nav_on_date()` 取该日的官方净值，取到即写回并置 `price_status='auto'`；
- 取不到则**保留待确认**，前端会显示具体原因（尚未公布 / 无该日净值 / 数据源失败），
  并允许用户手动补价；符合项目「取不到就明示、绝不估算」的铁律。

触发入口
--------
1. 本后台线程：每 `TICK_INTERVAL` 秒巡检一次；
2. 前端打开/刷新持仓页：`main.py` 在 `/api/positions` 中调用 `settle_pending()`（带节流）；
3. 用户手动点击「立即回填」：`POST /api/transactions/settle-pending`（force=True）。
"""
import threading
import time

from . import database as db
from . import datasource as ds

# 后台巡检间隔：净值日频更新，30 分钟粒度足够且不产生压力
TICK_INTERVAL = 30 * 60
# 页面触发补查的最小间隔（秒）：避免前端每次刷新都打一遍数据源
MANUAL_THROTTLE = 60

_lock = threading.Lock()
_stop = False
_thread = None
_last_check = 0.0


def settle_pending(force=False):
    """扫描并回填待确认交易。

    force=True 时忽略节流（后台巡检与手动触发使用）。
    返回 {"checked", "settled", "still_pending", "skippedFuture", ["throttled"|"busy"]}
      settled       已回填，每项 {id, code, nav, navDate, side, quantity}
      still_pending 仍未回填，每项 {id, code, reason, message, navDate}
    """
    global _last_check
    if not force:
        if (time.time() - _last_check) < MANUAL_THROTTLE:
            return {"checked": 0, "settled": [], "still_pending": [],
                    "skippedFuture": 0, "throttled": True}
    if not _lock.acquire(blocking=False):
        return {"checked": 0, "settled": [], "still_pending": [],
                "skippedFuture": 0, "busy": True}
    try:
        _last_check = time.time()
        pend = db.get_pending_transactions()
        settled, still, skipped = [], [], 0
        today = time.strftime("%Y-%m-%d")
        for t in pend:
            code = str(t.get("code") or "").strip()
            nav_date = str(t.get("nav_date") or "").strip()
            if not code:
                still.append({"id": t.get("id"), "code": code, "navDate": nav_date,
                              "reason": "no_code", "message": "交易缺少基金代码"})
                continue
            # 净值对应交易日仍在未来（如 15:00 后录入、成交日在下一交易日）→ 跳过，无需请求
            if nav_date and nav_date > today:
                skipped += 1
                continue
            # 按「净值对应交易日」取官方单位净值：传 before 使取值日直接落在该日
            probe_date = nav_date or str(t.get("trans_date") or today)
            try:
                r = ds.fund_nav_on_date(code, probe_date, "before")
            except Exception as e:                     # 数据源异常不得中断整轮
                r = {"available": False, "reason": "source_error", "nav": None,
                     "message": "净值数据源获取失败：%s" % str(e)}
            nav = r.get("nav")
            if r.get("available") and nav:
                ok = db.settle_transaction(int(t["id"]), nav, source="auto",
                                           nav_date=r.get("nav_date") or probe_date)
                if ok:
                    settled.append({"id": t.get("id"), "code": code,
                                    "side": t.get("side"), "quantity": t.get("quantity"),
                                    "nav": nav, "navDate": r.get("nav_date") or probe_date})
                    continue
            still.append({"id": t.get("id"), "code": code, "navDate": nav_date,
                          "reason": r.get("reason") or "unavailable",
                          "message": r.get("message") or "该日净值暂不可用"})
        return {"checked": len(pend), "settled": settled, "still_pending": still,
                "skippedFuture": skipped}
    finally:
        _lock.release()


def _loop():
    while not _stop:
        try:
            # 仅在存在待确认交易时才工作，避免无意义的空转请求
            if db.get_pending_transactions():
                settle_pending(force=True)
        except Exception:
            pass                                       # 后台任务不得因异常中断
        time.sleep(TICK_INTERVAL)


def start():
    """启动后台线程（应用启动时调用，幂等）。"""
    global _thread, _stop
    if _thread is not None and _thread.is_alive():
        return
    _stop = False
    _thread = threading.Thread(target=_loop, daemon=True, name="pending-settle")
    _thread.start()


def stop():
    global _stop
    _stop = True
