# -*- coding: utf-8 -*-
"""
指数当日分时「本地跟踪」模块（v31 第三需求）。

背景：指数 K 线弹窗默认分时、指数卡片当日涨幅下方有迷你分时小图。
数据优先走真实源（腾讯 minute/query 当日实时；东财 trends2 最近交易日），
**当某指数确认无任何真实分时源时**（如东财无、腾讯非其交易时段无当日数据），
由本模块启用「本地文件跟踪」：后端后台线程在其市场交易时段内，每分钟用
新浪报价采样一次最新价，写入本地文件，形成该指数当天的分时曲线（保留统计
数据供 K 线图/卡片使用）。

文件与交易日重置：
- data/intraday_track/tracked.json      跟踪名单（无源指数）
- data/intraday_track/{mkt}_{code}.json 分时记录 {trade_date, points:[{t,price}], ...}
- **每个新的交易日重置**：采样点日期(指数市场时区) 与文件 trade_date 不一致时，
  清空 points 重新记录；休市日不采样，文件保留上一交易日的完整记录（展示时
  标注数据日期，语义与"最近交易日分时"一致）。

数据真实性：仅用真实报价源（新浪 hq.sinajs.cn）在真实交易时段采样，不虚构点。
"""
import os
import json
import time
import threading
from datetime import datetime, timedelta, timezone

from . import datasource as ds

TRACK_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "data", "intraday_track")
TRACKED_FILE = os.path.join(TRACK_DIR, "tracked.json")
TICK_INTERVAL = 60          # 采样间隔（秒），用户确认：每 1 分钟
_lock = threading.Lock()


# ---------------------------------------------------------------
# 市场本地时间 / 交易时段（用于"该指数现在是否处于可采样交易时段"）
# ---------------------------------------------------------------
def _us_dst(date_obj):
    """2026 年起通用规则近似：3月第2个周日 ~ 11月第1个周日为夏令时(UTC-4)。"""
    def nth_sunday(year, month, n):
        d = datetime(year, month, 1)
        first_wd = d.weekday()
        offset = (6 - first_wd) % 7
        return (d + timedelta(days=offset + (n - 1) * 7)).date()
    start = nth_sunday(date_obj.year, 3, 2)
    end = nth_sunday(date_obj.year, 11, 1)
    return start <= date_obj < end


def market_local_dt(market):
    """返回该市场当前本地 (date, hhmm)。A股/港股=北京时间；美股=美东时间。"""
    now = datetime.now()
    if ds.normalize_market(market) == "US":
        # 美东 = UTC -4(夏令时) / -5
        utc = datetime.now(timezone.utc)
        dt = (utc - timedelta(hours=4 if _us_dst(utc.date()) else 5)).replace(tzinfo=None)
    else:
        dt = now
    return dt.date().strftime("%Y-%m-%d"), "%02d%02d" % (dt.hour, dt.minute)


def in_trade_window(market, date_str, hhmm):
    """是否处于该市场可采样交易时段（交易时段硬窗口 + 交易日近似）。"""
    m = ds.normalize_market(market)
    t = int(hhmm)
    if m == "A":
        if not (915 <= t <= 1505):
            return False
        ok, _ = ds.is_cn_trading_day(date_str)
        return ok
    if m == "HK":
        # 港股日历与A股大体一致（个别香港假日差异日由报价新鲜度/平线抑制兜底）
        if not (915 <= t <= 1610):
            return False
        ok, _ = ds.is_cn_trading_day(date_str)
        return ok
    if m == "US":
        # 美东工作日 09:15-16:15（美股节假日无报价变化，平线抑制会停止记录）
        if not (915 <= t <= 1615):
            return False
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        return dt.weekday() < 5
    return False


# ---------------------------------------------------------------
# 文件读写（thread-safe）
# ---------------------------------------------------------------
def _p(key):
    return os.path.join(TRACK_DIR, key.replace("|", "_") + ".json")


def _load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _save_json(path, obj):
    with _lock:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(obj, f, ensure_ascii=False, indent=1)
        except Exception:
            pass


def load_tracked():
    return _load_json(TRACKED_FILE, {"items": []})


def is_tracked(market, code):
    key = "%s|%s" % (ds.normalize_market(market), str(code))
    return any(it["market"] == ds.normalize_market(market) and str(it["code"]) == str(code)
               for it in load_tracked().get("items", []))


def ensure_tracked(market, code, name=""):
    """登记为无源跟踪对象（幂等）。"""
    m = ds.normalize_market(market)
    if is_tracked(m, code):
        return
    d = load_tracked()
    d.setdefault("items", []).append({"market": m, "code": str(code), "name": name or "",
                                      "added_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")})
    _save_json(TRACKED_FILE, d)


def remove_tracked(market, code):
    m = ds.normalize_market(market)
    d = load_tracked()
    items = [it for it in d.get("items", [])
             if not (it.get("market") == m and str(it.get("code")) == str(code))]
    if len(items) != len(d.get("items", [])):
        d["items"] = items
        _save_json(TRACKED_FILE, d)


def read_local(market, code):
    """读本地分时记录；无记录返回 None。"""
    m = ds.normalize_market(market)
    return _load_json(_p("%s|%s" % (m, code)), None)


# ---------------------------------------------------------------
# 采样
# ---------------------------------------------------------------
def _prev_close_of(market, code, quotes):
    """从新浪报价取昨收（优先 prev 字段；无则用现价与涨跌幅反推）。"""
    m = ds.normalize_market(market)
    sym = ds.to_sina_symbol(m, code)
    q = quotes.get(sym) or {}
    if q.get("prev"):
        return q["prev"]
    price, pct = q.get("price"), q.get("pct")
    if price and pct is not None and pct != 0:
        return round(price / (1 + pct / 100.0), 4)
    return None


def sample_once(market, code):
    """
    单次采样：处于交易时段且报价"活跃"时，把最新价写入本地分时文件。
    - 交易日重置：采样点市场日期 != 文件 trade_date → 清空重记；
    - 同分钟更新（覆盖），跨分钟追加；
    - 平线抑制：现价与末点相同且近 60 分钟无价格变化 → 跳过（防休市/节假日平线）。
    """
    m = ds.normalize_market(market)
    c = str(code)
    date_str, hhmm = market_local_dt(m)
    if not in_trade_window(m, date_str, hhmm):
        return False
    sym = ds.to_sina_symbol(m, c)
    try:
        quotes = ds.sina_quotes([sym])
    except Exception:
        return False
    q = quotes.get(sym) or {}
    price = q.get("price")
    if not price or price <= 0:
        return False
    # 报价新鲜度：A股/港股带源日期，非今日视为不活跃（休市/停牌）
    src_date = q.get("src_date") or ""
    if src_date:
        expect = date_str.replace("/", "-")
        if src_date.replace("/", "-") != expect:
            return False
    prev_close = _prev_close_of(m, c, quotes)
    now_s = datetime.now().strftime("%Y-%m-%d %H:%M")
    f = read_local(m, c) or {"trade_date": "", "points": []}
    trade_date = f.get("trade_date") or ""
    if trade_date != date_str:
        # 新的交易日 → 重置
        f = {"trade_date": date_str, "prev_close": prev_close, "points": []}
    pts = f.get("points") or []
    # 平线抑制
    if pts:
        last_p = pts[-1].get("price")
        if abs(last_p - price) < 1e-9:
            # 找最近价格变化时刻
            change_t = pts[0].get("t")
            for pt in reversed(pts):
                if abs(pt.get("price") - price) >= 1e-9:
                    change_t = pt.get("t")
                    break
            try:
                last_change = datetime.strptime(change_t, "%Y-%m-%d %H:%M")
            except Exception:
                last_change = None
            if last_change and (datetime.now() - last_change).total_seconds() < 3600:
                return False  # 60 分钟内价格未变 → 视为非活跃交易
    # 同分钟覆盖 / 跨分钟追加
    if pts and pts[-1].get("t", "")[:16] == now_s[:16]:
        pts[-1]["price"] = round(price, 4)
    else:
        pts.append({"t": now_s, "price": round(price, 4)})
    f["points"] = pts
    f["prev_close"] = prev_close
    f["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    _save_json(_p("%s|%s" % (m, c)), f)
    return True


def tick():
    """后台每分钟执行：对跟踪名单中的每个指数采样一次。"""
    for it in load_tracked().get("items", []):
        try:
            sample_once(it.get("market", "A"), it.get("code", ""))
        except Exception:
            continue


def start():
    """启动后台跟踪线程（daemon，60s 周期）。"""
    def _loop():
        while True:
            try:
                tick()
            except Exception:
                pass
            time.sleep(TICK_INTERVAL)
    t = threading.Thread(target=_loop, daemon=True, name="intraday-track")
    t.start()
    return t
