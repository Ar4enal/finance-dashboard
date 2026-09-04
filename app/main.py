# -*- coding: utf-8 -*-
"""
金融工作台 - FastAPI 主应用
行情 / K线 / 自选 / 持仓 / 组合 / 报表 / 基金 / 资讯 全部接口。
兼容 Python 3.7。
"""
import os
import re
import time
from datetime import datetime
from typing import Optional, List

from fastapi import FastAPI, Query, Body
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import datasource as ds
from . import indicators as ind
from . import database as db
from . import intraday_track as itrack

app = FastAPI(title="金融工作台", version="1.0.0")

# CORS（本地开发用）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def ok(data=None, msg="ok"):
    return {"code": 0, "data": data, "msg": msg}


def fail(msg):
    return JSONResponse({"code": 1, "data": None, "msg": msg})


# =========================================================
# 行情
# =========================================================
@app.get("/api/quotes")
def get_quote(market: str, code: str):
    mkt = ds.normalize_market(market)
    sym = ds.to_sina_symbol(mkt, code)
    try:
        quotes = ds.sina_quotes([sym])
    except ds.DataSourceError as e:
        return fail(str(e))
    if sym not in quotes:
        return fail("未获取到行情: %s" % code)
    q = quotes[sym]
    return ok({"market": mkt, "code": code, "name": q["name"], "price": q["price"],
               "chg": q["chg"], "pct": q["pct"], "updateTime": datetime.now().strftime("%H:%M:%S")})


@app.get("/api/quotes/batch")
def batch_quotes(items: str = Query(..., description="格式: A:sh600519,US:aapl")):
    """批量报价。items 逗号分隔，每项 market:code。
    对每个标的均返回条目；获取失败的标的是 available=False（绝不回退虚拟数据）。"""
    results = []
    for item in items.split(","):
        item = item.strip()
        if not item:
            continue
        if ":" in item:
            mkt, code = item.split(":", 1)
        else:
            mkt, code = "A", item
        mkt = ds.normalize_market(mkt)
        sym = ds.to_sina_symbol(mkt, code)
        entry = {"market": mkt, "code": code, "available": False}
        try:
            quotes = ds.sina_quotes([sym])
            if sym in quotes and quotes[sym].get("price"):
                q = quotes[sym]
                entry.update({
                    "name": q["name"], "price": q["price"], "chg": q["chg"],
                    "pct": q["pct"], "available": True,
                })
        except ds.DataSourceError:
            pass
        results.append(entry)
    return ok(results)


# =========================================================
# K线 + 技术指标
# =========================================================
# 周期与取数档位（v31）：日K/周K/月K/年K 覆盖长历史（腾讯原生 day/week/month +
# 月K聚合年K，前复权；个股日K前复权源上限约 640 根≈2.6年，指数/港股约 1000 根）；
# 分钟K（m1/m5/m15/m30/m60）仅 A股（含指数）有真实数据源。
PERIOD_SCALE_SINA = {"day": 240, "week": 1200, "month": 7200}   # 新浪 scale 映射
PERIOD_DEFAULT_COUNT = {"day": 1000, "week": 640, "month": 500, "year": 60,
                        "m1": 240, "m5": 240, "m15": 240, "m30": 240, "m60": 240}
MINUTE_PERIODS = ("m1", "m5", "m15", "m30", "m60")
AGG_PERIODS = ("week", "month", "year")


def _slice_k(k, count):
    if count and count > 0 and len(k.get("dates") or []) > count:
        return {"dates": k["dates"][-count:], "ohlc": k["ohlc"][-count:],
                "volume": k["volume"][-count:]}
    return k


def _kline_period(sym, period, count):
    """按周期取 K 线（腾讯/新浪原生优先，细粒度聚合兜底），返回统一 dict；失败返回空 dict。
    period ∈ day/week/month/year；sym 为腾讯/新浪通用代码（如 sh600519 / hk00700 / usAAPL.OQ）。
    - day：腾讯 fqkline 优先 → 新浪 scale=240；
    - week/month：腾讯原生 → 新浪原生 → 日K聚合兜底（北交所等）；
    - year：腾讯 month → 新浪 month → 聚合年度（腾讯 year 仅返回当年 1 根，故统一走月K聚合，
      聚合为真实数据加工，不引入虚拟数据）。"""
    out = {"dates": [], "ohlc": [], "volume": []}
    if period == "day":
        for fn in (lambda: ds.tencent_kline(sym, "day", count),
                   lambda: ds.sina_kline(sym, scale=240, datalen=max(count, 300))):
            try:
                k = fn()
            except Exception:
                continue
            if len(k.get("dates") or []) >= 2:
                return _slice_k(k, count)
        return out
    if period in ("week", "month"):
        scale = PERIOD_SCALE_SINA[period]
        for fn in (lambda: ds.tencent_kline(sym, period, count),
                   lambda: ds.sina_kline(sym, scale=scale, datalen=max(count * 2, 300))):
            try:
                k = fn()
            except Exception:
                continue
            if len(k.get("dates") or []) >= 2:
                return _slice_k(k, count)
        # 日K聚合兜底
        day_k = out
        try:
            day_k = ds.sina_kline(sym, scale=240, datalen=1200)
        except Exception:
            try:
                day_k = ds.tencent_kline(sym, "day", 1600)
            except Exception:
                day_k = out
        if len(day_k.get("dates") or []) >= 2:
            return _slice_k(ds.aggregate_kline(day_k, period), count)
        return out
    # year：月K聚合年度
    for fn in (lambda: ds.tencent_kline(sym, "month", 640),
               lambda: ds.sina_kline(sym, scale=7200, datalen=800)):
        try:
            m = fn()
        except Exception:
            continue
        if len(m.get("dates") or []) >= 2:
            return _slice_k(ds.aggregate_kline(m, "year"), count)
    return out


def _fetch_kline(sym, period="day", count=120):
    """腾讯/新浪周期K线取数，任何异常都返回空 dict（由调用方决定提示口径）。"""
    try:
        return _kline_period(sym, period, count)
    except Exception:
        return {"dates": [], "ohlc": [], "volume": []}


@app.get("/api/kline")
def get_kline(market: str, code: str, period: str = "day", count: int = None):
    mkt = ds.normalize_market(market)
    proxied = False
    proxy_note = None
    if period not in (("day",) + tuple(AGG_PERIODS) + MINUTE_PERIODS):
        return fail("不支持的周期: %s" % period)
    if count is None or count <= 0:
        count = PERIOD_DEFAULT_COUNT.get(period, 640)
    try:
        # ---- 分钟K线（分时K线）：仅 A股（含指数）有真实数据源 ----
        if period in MINUTE_PERIODS:
            if mkt != "A":
                return fail("该标的分时/分钟K线数据源暂不可用（当前仅A股提供分钟K线）")
            sym = ds.to_sina_symbol(mkt, code)
            try:
                k = ds.tencent_mkline(sym, freq=period, count=count)
            except ds.DataSourceError as e:
                return fail("分钟K线数据暂不可用（%s）" % str(e))
            if len(k["dates"]) < 2:
                return fail("分钟K线数据暂不可用")
        # ---- 基金：天天基金单位净值历史（无盘中OHLC，等值K线；周/月/年按净值日聚合）----
        elif mkt == "FUND":
            try:
                need = {"day": count, "week": count * 7, "month": count * 31,
                        "year": count * 366}.get(period, count)
                k = ds.fund_kline(code, count=max(need, 300))
            except ds.DataSourceError:
                return fail("基金K线获取失败")
            if not k["dates"]:
                return fail("基金K线数据为空")
            if period != "day":
                k = _slice_k(ds.aggregate_kline(k, period), count)
        # ---- 黄金：新浪期货日K（周/月/年按日K聚合，真实加工）----
        elif mkt == "GOLD":
            if code == "GOLD_PHYSICAL":
                try:
                    k = ds.sina_futures_kline("AU0", count=max(count * 366, 2000) if period != "day" else count)
                except ds.DataSourceError as e:
                    return fail("实物黄金K线数据源暂不可用（%s）" % str(e))
            else:
                futures_map = {"nf_AU0": "AU0", "AU0": "AU0", "hf_GC": "GC0", "hf_XAU": "XAUUSD"}
                fsym = futures_map.get(code, code)
                try:
                    k = ds.sina_futures_kline(fsym, count=max(count * 366, 2000) if period != "day" else count)
                except ds.DataSourceError:
                    if code in ("hf_GC", "hf_XAU"):
                        label = "纽约金(COMEX GC)" if code == "hf_GC" else "伦敦金(XAU/USD)"
                        try:
                            k = ds.sina_futures_kline("AU0", count=max(count * 366, 2000) if period != "day" else count)
                        except ds.DataSourceError as e:
                            return fail("黄金K线数据源暂不可用（%s）" % str(e))
                        proxied = True
                        proxy_note = ("%s 历史K线真实数据源暂不可达，以下为沪金 AU0 真实K线"
                                      "（同为黄金、走势强相关；单位为元/克，与%s的美元/盎司计价不同，仅供参考）"
                                      % (label, label))
                    else:
                        return fail("该黄金品种K线数据源暂不可用")
            if not k["dates"]:
                return fail("K线数据暂不可用")
            if period != "day":
                k = _slice_k(ds.aggregate_kline(k, period), count)
        # ---- 美股个股/海外指数：个股 fqkline → 指数 usfqkline ----
        elif mkt == "US":
            if period in MINUTE_PERIODS:
                return fail("该标的分时/分钟K线数据源暂不可用（当前数据源仅A股提供分钟K线）")
            code_u = code.upper()
            k = _kline_period("us" + code_u + ".OQ", period, count)  # 美股个股
            if len(k.get("dates") or []) < 2:
                # 指数：usfqkline（仅 qfq 键；day/week/month 原生，year=month 聚合）
                k = {"dates": [], "ohlc": [], "volume": []}
                try:
                    if period == "year":
                        m = ds.tencent_us_index_kline("us" + code_u, "month", 640)
                        if len(m.get("dates") or []) >= 2:
                            k = ds.aggregate_kline(m, "year")
                    else:
                        k = ds.tencent_us_index_kline("us" + code_u, period, count)
                except Exception:
                    k = {"dates": [], "ohlc": [], "volume": []}
                if len(k.get("dates") or []) >= 2:
                    k = _slice_k(k, count)
        else:
            # 国内/港股/债券等：腾讯 fqkline（v31 起 proxy 域名）为主源；新浪为备；聚合兜底。
            sym = ds.to_sina_symbol(mkt, code)
            k = _fetch_kline(sym, period=period, count=count)
        if not k["dates"]:
            return fail("K线数据暂不可用")
        # 计算指标
        closes = [o[1] for o in k["ohlc"]]  # close 在 ohlc[1]
        ma5 = ind.simple_ma(closes, 5)
        ma10 = ind.simple_ma(closes, 10)
        ma20 = ind.simple_ma(closes, 20)
        dif, dea, bar = ind.macd(closes)
        return ok({
            "dates": k["dates"],
            "ohlc": k["ohlc"],
            "volume": k["volume"],
            "ma5": ma5, "ma10": ma10, "ma20": ma20,
            "macdDIF": dif, "macdDEA": dea, "macdBAR": bar,
            "period": period,
            "proxied": proxied,
            "proxy_note": proxy_note,
        })
    except ds.DataSourceError:
        return fail("K线数据暂不可用")
    except Exception:
        # 任何未预期异常都返回友好提示，绝不让端点抛出 500（避免前端 JSON.parse 报 "Internal Server Error"）
        return fail("K线数据暂不可用")


# ---------------------------------------------------------------
# 当日/最近交易日分时：统一数据链（v31）
#   1) 腾讯 minute/query —— 当日逐分钟实时（A股/港股盘中；美股其交易时段）；
#   2) 东财 trends2     —— 最近交易日逐分钟（A/港股盘中=当日；美股=上一美股交易日全天）；
#   3) 本地跟踪文件     —— 确认无任何真实分时源的指数，由其交易时段内每分钟新浪报价采样积累；
#   4) 全无 → available=False + 明确 note（绝不造假），并登记本地跟踪等待积累。
# 每个响应带 source 与 trade_date（数据所属交易日），前端可标注"最近交易日"。
# ---------------------------------------------------------------
_INTRA_CACHE = {}          # key -> (ts, result)，30s 缓存降低批量探测开销
_INTRA_CACHE_TTL = 30


def _intra_note_unavailable(mkt, code=None):
    d, hhmm = itrack.market_local_dt(mkt)
    if mkt == "GOLD":
        # 黄金指数分时 = 本地记录（v32 需求5）：动态附上已记录点数，直观反馈"记录中"
        n = 0
        try:
            local = itrack.read_local(mkt, code or "")
            n = len((local or {}).get("points") or [])
        except Exception:
            pass
        tail = ("已记录 %d 个采样点，满 2 点后自动显示当日分时曲线。" % n) if n >= 1 \
            else "系统将在下一分钟采样首个实时价（真实行情源）。"
        return ("该黄金指数无外部实时分时数据源，分时已改用本地记录：系统运行期间每"
                "分钟自动记录其当日实时价作为分时数据源（按北京自然日，0点重置）。%s"
                "当日更早数据无法回补（绝不虚构），建议交易时段保持本工作台运行以积累完整曲线。" % tail)
    if mkt == "US":
        t = int(hhmm)
        if 915 <= t <= 1615:
            return ("该美股指数实时分时数据源暂不可用，已启用本地跟踪："
                    "美股开盘期间保持本工作台运行，将每分钟自动记录当天分时")
        return ("美股当前休市（美东 %s:%s）。实时分时仅在其交易时段提供；"
                "已启用本地跟踪，美股开盘期间保持本工作台运行将自动记录当天分时"
                % (hhmm[:2], hhmm[2:]))
    t = int(hhmm)
    active = (mkt == "A" and 915 <= t <= 1505) or (mkt == "HK" and 915 <= t <= 1610)
    if active:
        return "该标的分时数据源暂不可用，已启用本地跟踪（交易时段每分钟自动记录）"
    return ("非交易时段，暂无当日分时数据（本地跟踪已启用：下一交易日交易时段"
            "每分钟自动记录当天分时，并在每个新交易日重置）")


def _intraday_for(market, code, want_detail=True):
    """统一分时数据链，返回 dict：
    {available, source, trade_date, times, price, avg_price, volume, amount,
     prev_close, name, note}。"""
    mkt = ds.normalize_market(market)
    c = str(code)
    key = "%s|%s" % (mkt, c)
    hit = _INTRA_CACHE.get(key)
    if hit and time.time() - hit[0] < _INTRA_CACHE_TTL:
        return hit[1]
    out = {"available": False, "source": None, "trade_date": "", "times": [],
           "price": [], "avg_price": [], "volume": [], "amount": [],
           "prev_close": None, "name": "", "note": ""}
    if mkt == "FUND":
        out["note"] = "基金仅有日级净值数据，无当日分时"
        _INTRA_CACHE[key] = (time.time(), out)
        return out
    sym = ds.to_sina_symbol(mkt, c)
    loc_date, _hh = itrack.market_local_dt(mkt)

    # ---- 0) 黄金（GOLD 期货指数：纽约金/沪金/伦敦金等）：无外部逐分钟源，
    #          分时 = 本地记录（系统运行期间每分钟采样当日实时价，v32 需求5）----
    if mkt == "GOLD":
        local = itrack.read_local(mkt, c)
        if local and len(local.get("points") or []) >= 2:
            pts = local["points"]
            out.update({
                "available": True, "source": "local",
                "trade_date": local.get("trade_date") or "",
                "times": [p["t"][5:16] for p in pts],
                "price": [p["price"] for p in pts],
                "avg_price": [], "volume": [], "amount": [],
                "prev_close": local.get("prev_close"),
                "note": "分时数据源：本地记录（系统每分钟记录当日实时价，0点重置）",
            })
            _INTRA_CACHE[key] = (time.time(), out)
            return out
        itrack.ensure_tracked(mkt, c, name=c)
        out["note"] = _intra_note_unavailable(mkt, c)
        _INTRA_CACHE[key] = (time.time(), out)
        return out

    # ---- 1) 腾讯当日实时 ----
    try:
        d = ds.tencent_minute_today(sym)
        if len(d.get("times") or []) >= 2:
            mult = 100.0 if mkt == "A" else 1.0
            vol_share = [v * mult for v in d["volume"]]
            is_index = mkt == "A" and (re.match(r"^sh000\d{3}$", sym) or re.match(r"^sz399\d{3}$", sym)
                                       or re.match(r"^bj899\d{3}$", sym))
            avg = []
            for amt, vs in zip(d["amount"], vol_share):
                avg.append(round(amt / vs, 3) if (not is_index and vs > 0) else None)
            minute_vol = [vol_share[0]] if vol_share else []
            for i in range(1, len(vol_share)):
                minute_vol.append(max(vol_share[i] - vol_share[i - 1], 0))
            out.update({
                "available": True, "source": "tencent", "trade_date": loc_date,
                "times": d["times"], "price": d["price"], "avg_price": avg,
                "volume": minute_vol, "amount": d["amount"],
                "prev_close": d.get("prev_close"),
                "note": "分时数据源：腾讯行情（当日逐分钟实时）",
            })
            itrack.remove_tracked(mkt, c)  # 有真实源 → 无需本地跟踪
            _INTRA_CACHE[key] = (time.time(), out)
            return out
    except ds.DataSourceError:
        pass

    # ---- 2) 东财最近交易日 ----
    secid = ds.em_secid(mkt, c)
    if secid:
        try:
            e = ds.eastmoney_trends(secid)
            if len(e.get("price") or []) >= 2:
                # 昨收：腾讯报价探测不到时用新浪报价反推（东财响应无 prePrice 字段）
                prev = None
                try:
                    q = ds.sina_quotes([sym]).get(sym) or {}
                    if q.get("prev"):
                        prev = q["prev"]
                    elif q.get("price") and q.get("pct") is not None and q["pct"] != 0:
                        prev = round(q["price"] / (1 + q["pct"] / 100.0), 4)
                except Exception:
                    prev = None
                out.update({
                    "available": True, "source": "eastmoney",
                    "trade_date": e.get("trade_date") or loc_date,
                    "times": e["dates"], "price": e["price"],
                    "avg_price": e.get("avg_price") or [], "volume": e.get("volume") or [],
                    "amount": e.get("amount") or [], "prev_close": prev,
                    "name": e.get("name") or "",
                    "note": "分时数据源：东方财富（最近交易日逐分钟）",
                })
                itrack.remove_tracked(mkt, c)  # 有真实源 → 无需本地跟踪
                _INTRA_CACHE[key] = (time.time(), out)
                return out
        except ds.DataSourceError:
            pass

    # ---- 3) 本地跟踪文件 ----
    local = itrack.read_local(mkt, c)
    if local and len(local.get("points") or []) >= 2:
        pts = local["points"]
        out.update({
            "available": True, "source": "local",
            "trade_date": local.get("trade_date") or "",
            "times": [p["t"][5:16] for p in pts],
            "price": [p["price"] for p in pts],
            "avg_price": [], "volume": [], "amount": [],
            "prev_close": local.get("prev_close"),
            "note": "分时数据源：本地跟踪记录（每分钟采样，交易日自动重置）",
        })
        _INTRA_CACHE[key] = (time.time(), out)
        return out

    # ---- 4) 全无：登记本地跟踪 + 明确提示 ----
    itrack.ensure_tracked(mkt, c, name=c)
    out["note"] = _intra_note_unavailable(mkt)
    _INTRA_CACHE[key] = (time.time(), out)
    return out


@app.get("/api/kline/intraday")
def get_intraday(market: str, code: str):
    """当日/最近交易日分时（统一数据链，见 _intraday_for）。
    返回 {available, source, trade_date, times, price, avg_price, volume, amount,
    prev_close, note}；无法取到真实数据时 available=False + note，绝不造假。"""
    return ok(_intraday_for(market, code, want_detail=True))


@app.get("/api/kline/intraday/batch")
def get_intraday_batch(items: str = Query(..., description="格式: A:sh000001,US:ixic")):
    """指数卡片迷你分时批量接口（轻量：仅 price/prev_close/trade_date）。
    每项走统一数据链，30s 缓存；无源指数自动登记本地跟踪。"""
    result = {}
    for item in items.split(","):
        item = item.strip()
        if not item:
            continue
        if ":" in item:
            mkt, code = item.split(":", 1)
        else:
            mkt, code = "A", item
        d = _intraday_for(mkt, code, want_detail=False)
        result["%s:%s" % (ds.normalize_market(mkt), code)] = {
            "available": d["available"], "source": d["source"],
            "trade_date": d["trade_date"], "price": d["price"],
            "prev_close": d["prev_close"], "note": d["note"],
        }
    return ok(result)


# =========================================================
# 基金详情
# =========================================================
@app.get("/api/fund/detail")
def fund_detail(code: str):
    # 净值
    sym = "fu_" + code
    try:
        quotes = ds.sina_quotes([sym])
        q = quotes.get(sym, {})
    except ds.DataSourceError:
        q = {}
    # 持仓
    try:
        holdings = ds.fund_holdings(code, topline=10)
    except ds.DataSourceError:
        holdings = []
    nav = {
        "code": code,
        "name": q.get("name", code),
        "nav": q.get("price"),
        "prevNav": q.get("prev"),
        "chg": q.get("chg"),
        "pct": q.get("pct"),
        "acc_nav": q.get("acc_nav"),
    }
    # 重仓股实时行情
    stock_codes = []
    stock_quotes = []
    for h in holdings:
        sc = h["code"]
        if sc.startswith(("6", "9")):
            sc = "sh" + sc
        else:
            sc = "sz" + sc
        stock_codes.append(sc)
    if stock_codes:
        try:
            sq = ds.sina_quotes(stock_codes)
            for sc in stock_codes:
                if sc in sq:
                    s = sq[sc]
                    stock_quotes.append({"code": sc, "name": s["name"], "price": s["price"],
                                         "chg": s["chg"], "pct": s["pct"]})
        except ds.DataSourceError:
            pass
    return ok({"nav": nav, "holdings": holdings, "stock_quotes": stock_quotes})


@app.get("/api/fund/penetrate")
def fund_penetrate(code: str, topline: int = Query(10, ge=1, le=10)):
    """场内基金穿透估算：重仓股实时涨跌加权 → 估算净值/折溢价。"""
    try:
        data = ds.fund_penetration(code, topline=topline)
    except ds.DataSourceError as e:
        return fail(str(e))
    if not data.get("available"):
        return ok(data)  # 返回 available=False + 原因
    return ok(data)


@app.get("/api/fund/qdii")
def fund_qdii_codes():
    """返回 QDII（非国内）基金代码集合与判断函数，供录入交易时识别 T+2 确认规则。"""
    codes = sorted(ds.QDII_FUND_CODES)
    return ok({"codes": codes, "count": len(codes)})


@app.get("/api/fund/qdii/check")
def fund_qdii_check(code: str):
    """判断指定基金代码是否为 QDII（非国内）基金。"""
    return ok({"code": code, "is_qdii": ds.is_qdii_fund(code)})


@app.get("/api/fund/confirm-date")
def fund_confirm_date(trans_date: str, qdii: bool = False, time: str = "before"):
    """计算基金确认份额日期（跳过周末与官方休市日）。

    - 境内普通基金：15:00 前 -> T+1，15:00 后 -> T+2
    - QDII（非国内）基金：确认份额固定 T+2（不受 15:00 前后影响）
    休市数据来源：沪深北交易所官方公告（2026 年）。未覆盖年份 available=False 并提示。

    返回 {confirm_date, rule, available, holiday_source_note}
    """
    dt = ds._parse_date(trans_date)
    if dt is None:
        return fail("交易日期格式错误，应为 YYYY-MM-DD")
    tplus = 2 if qdii else (2 if time == "after" else 1)
    confirm_date, covered = ds.next_cn_trading_day(trans_date, tplus)
    rule = ("QDII基金 T+2" if qdii else ("15:00后 T+2" if time == "after" else "15:00前 T+1"))
    if not covered:
        # 该年份休市安排无真实数据，仅按周末估算，必须提醒用户
        return ok({
            "confirm_date": confirm_date,
            "rule": rule + "（仅跳过周末，法定节假日未知）",
            "available": False,
            "holiday_source_note": "该年份休市安排未收录真实数据，仅按周末推算，请手动核对法定节假日",
        })
    return ok({
        "confirm_date": confirm_date,
        "rule": rule,
        "available": True,
        "holiday_source_note": ds.HOLIDAY_SOURCE_NOTE,
    })


@app.get("/api/fund/penetration/holdings")
def penetration_holdings():
    """遍历用户持仓中的基金（交易记录 market=FUND + 新增持仓 position_override 的 FUND），
    做穿透估算概览，并按「当天收益」排序（估算涨跌 est_pct 降序，缺失用实际净值涨跌 pct）。"""
    fund_codes = []
    seen = set()
    # 1) 交易记录中的基金
    for t in db.get_transactions():
        if t.get("market") == "FUND" and t.get("code"):
            c = str(t["code"])
            if c not in seen:
                seen.add(c)
                fund_codes.append(c)
    # 2) 新增持仓（position_override）中的基金——穿透概览必须包含
    for (mk, cd), ov in db.get_position_overrides().items():
        if mk == "FUND" and str(cd) not in seen:
            seen.add(str(cd))
            fund_codes.append(str(cd))
    results = []
    for c in fund_codes:
        try:
            results.append(ds.fund_penetration(c))
        except ds.DataSourceError:
            results.append({"code": c, "name": str(c), "available": False,
                            "unavailable": "穿透数据获取失败"})
    # 按当天收益排序：估算涨跌 est_pct 为主（缺失用实际 pct），降序
    def _day_ret(item):
        if item.get("available") is False:
            return float("-inf")
        return item.get("est_pct") if item.get("est_pct") is not None else item.get("pct") or 0
    results.sort(key=_day_ret, reverse=True)
    return ok(results)


# =========================================================
# 实物黄金（用户持有克数 + 成本价，实时金价估值）
# =========================================================
@app.get("/api/gold")
def gold_holding():
    """实物黄金持仓 + 实时国内金价（元/克）。
    v32 需求3 起附带实物黄金三项盈亏：
      pnl=持仓盈亏、cum_pnl=累计盈亏、day_pnl=当日盈亏（克数×(今价−沪金AU0昨收)）。
    v32fix：pnl/cum_pnl 与持仓明细实物黄金条目同源（复用 _gold_position，
    含用户在持仓卡片手动编辑的累计/持仓收益覆盖），保证两处显示永远一致；
    day_pnl 为实时口径独立计算。金价/昨收不可用或未持仓时对应字段 None，绝不填充虚拟值。"""
    holding = db.get_gold_holding()
    g = ds.gold_cn_price()
    sess = _gold_session_status(g)      # 金价交易状态（跟随当前源），价不可用为 None
    grams = holding["grams"]
    cost_price = holding["cost_price"]
    cost = round(cost_price * grams, 2)
    rpnl = db.compute_gold_realized_pnl()
    # 实时市值与盈亏；金价可用且持仓时复用持仓明细同源计算（含用户收益编辑覆盖）
    market_value = None
    pnl = None
    pnl_pct = None
    cum_pnl = None
    day_pnl = None
    if g["available"] and grams > 0:
        gp = _gold_position(g=g)          # 与持仓明细实物黄金卡片完全同源（含手动编辑）
        if gp is None:                     # 防御兜底：按未编辑口径计算（理论不可达）
            market_value = round(g["price"] * grams, 2)
            pnl = round(market_value - cost, 2)
            pnl_pct = round(pnl / cost * 100, 2) if cost else 0
            cum_pnl = round(rpnl + pnl, 2)
        else:
            market_value = gp["market_value"]
            pnl = gp["holdingPnl"]         # 持仓盈亏（编辑后口径）
            pnl_pct = gp["holdingPnlPct"]
            cum_pnl = gp["cumPnl"]         # 累计盈亏 = 编辑基准/已实现 + 实时持仓收益
        prev_gold = _au0_prev_close()
        if prev_gold and prev_gold > 0:
            # 当日盈亏：实时金价估值口径，与总览「当日收益」卡片实物黄金一致
            day_pnl = round(g["price"] * grams - prev_gold * grams, 2)
    return ok({
        "grams": grams,
        "cost_price": cost_price,
        "price": g["price"],            # 实时金价（元/克）
        "price_available": g["available"],
        "price_name": g["name"],
        "price_pct": g["pct"],
        "price_asof": g.get("asof", ""),  # 金价最后更新时间（如 2026-09-04 11:30）
        "price_trade_status": (sess or {}).get("status"),  # 当前交易状态（交易中/午间休市…）
        "price_hours_hint": (sess or {}).get("hint"),      # 该金价源完整交易时段说明
        "market_value": market_value,
        "cost": cost,
        "pnl": pnl,
        "pnl_pct": pnl_pct,
        "realized_pnl": rpnl,            # 已实现收益（卖出流水累计）
        "cum_pnl": cum_pnl,              # 累计盈亏（与持仓明细同源，含手动编辑）
        "day_pnl": day_pnl,              # 当日盈亏（克数×(今价−沪金AU0昨收)）
        "updated_at": holding["updated_at"],
    })


@app.post("/api/gold/save")
def gold_save(grams: float = Query(..., description="持有克数，≥0"),
              cost_price: float = Query(..., description="成本价（元/克），≥0")):
    if grams < 0 or cost_price < 0:
        return fail("克数与成本价须为非负数")
    holding = db.save_gold_holding(round(grams, 4), round(cost_price, 4))
    return ok(holding)


@app.delete("/api/gold")
def gold_delete():
    """清空实物黄金（克数与成本价归零）。"""
    holding = db.save_gold_holding(0, 0)
    return ok(holding)


# =========================================================
# 实物黄金交易流水（买入/卖出录入，按加权平均成本更新持仓与收益）
# =========================================================
@app.get("/api/gold/transactions")
def gold_txns():
    """实物黄金买卖流水（按日期升序）。"""
    return ok(db.get_gold_txns())


@app.post("/api/gold/transactions")
def gold_txn_add(side: str = Query(..., description="BUY 买入 / SELL 卖出"),
                 grams: float = Query(..., description="买卖克数，>0"),
                 price: float = Query(..., description="成交单价（元/克），>0"),
                 trans_date: str = Query("", description="成交日期 YYYY-MM-DD"),
                 note: str = Query("", description="备注")):
    """录入一笔实物黄金买卖。买入加权加仓、卖出按当前平均成本减仓，
    并按全部流水重放更新持有克数与成本价，收益随实时金价自动计算。"""
    side_u = (side or "").upper()
    if side_u not in ("BUY", "SELL"):
        return fail("方向须为 BUY 或 SELL")
    if grams <= 0 or price <= 0:
        return fail("克数与价格须为正数")
    if not trans_date:
        trans_date = db.today_str()
    result = db.add_gold_txn(side_u, grams, price, trans_date, note or "")
    return ok(result)


@app.delete("/api/gold/transactions/{tid}")
def gold_txn_del(tid: int):
    """删除一笔实物黄金交易，并按剩余流水重放重建持仓。"""
    result = db.delete_gold_txn(tid)
    return ok(result)



@app.get("/api/watchlist")
def watchlist():
    items = db.get_watchlist()
    # 尝试补齐名称
    for it in items:
        if not it["name"]:
            sym = ds.to_sina_symbol(ds.normalize_market(it["market"]), it["code"])
            try:
                quotes = ds.sina_quotes([sym])
                it["name"] = quotes.get(sym, {}).get("name", it["code"])
            except ds.DataSourceError:
                pass
    return ok(items)


@app.post("/api/watchlist")
def add_watch(market: str, code: str, name: str = ""):
    mkt = ds.normalize_market(market)
    if not name:
        sym = ds.to_sina_symbol(mkt, code)
        try:
            quotes = ds.sina_quotes([sym])
            name = quotes.get(sym, {}).get("name", code)
        except ds.DataSourceError:
            name = code
    db.add_watchlist(mkt, code, name)
    return ok()


@app.delete("/api/watchlist/{wid}")
def del_watch(wid: int):
    db.delete_watchlist(wid)
    return ok()


# =========================================================
# 行情看板指数配置（用户自定义选择/新增/删除）
# =========================================================
@app.get("/api/indices")
def indices_list():
    """返回行情看板指数配置列表（首次启动已自动填充内置预置）。"""
    return ok(db.get_custom_indices())


@app.post("/api/indices")
def indices_add(name: str = Query(..., description="指数名称"),
                market: str = Query(..., description="市场标识，如 A/US"),
                code: str = Query(..., description="指数代码，如 sh000001 / ixic")):
    """新增一个指数（重复 (market,code) 自动忽略）。"""
    mkt = ds.normalize_market(market)
    if not code.strip():
        return fail("指数代码不能为空")
    if not name.strip():
        # 自动补名称
        sym = ds.to_sina_symbol(mkt, code)
        try:
            quotes = ds.sina_quotes([sym])
            name = quotes.get(sym, {}).get("name", code)
        except ds.DataSourceError:
            name = code
    db.add_custom_index(name, mkt, code)  # add_custom_index(name, market, code)
    return ok({"name": name, "market": mkt, "code": code})


@app.delete("/api/indices/{idx_id}")
def indices_del(idx_id: int):
    db.delete_custom_index(idx_id)
    return ok({"id": idx_id})


@app.post("/api/indices/{idx_id}/move")
def index_move(idx_id: int, dir: str = Query(..., description="up/down")):
    """移动指数位置（与相邻行交换 sort_order）。
    顶部/底部已无相邻行时 moved=False（前端对应按钮变灰）。"""
    if dir not in ("up", "down"):
        return fail("dir 必须为 up 或 down")
    moved = db.swap_index_sort_order(idx_id, dir)
    return ok({"id": idx_id, "dir": dir, "moved": moved})


# =========================================================
# A股板块资金流向（当天前十流入/流出）
# =========================================================
@app.get("/api/quotes/sector-flow")
def sector_flow(top: int = Query(10, ge=5, le=20)):
    """A股行业板块资金流向：当天主力净流入/流出 TOP N（真实数据，失败返回 available=False）。"""
    return ok(ds.sector_money_flow(top=top))


# =========================================================
# 持仓置顶（持仓管理页）
# =========================================================
@app.get("/api/position/pins")
def position_pins():
    """返回置顶持仓列表 [{market, code, pinned_at}]。"""
    return ok(db.get_pinned_positions())


@app.post("/api/position/pin")
def position_pin(market: str = Query(..., description="市场标识"),
                 code: str = Query(..., description="产品代码")):
    """置顶某持仓（幂等）。"""
    mkt = ds.normalize_market(market)
    db.set_pin_position(mkt, code)
    return ok({"market": mkt, "code": code})


@app.delete("/api/position/pin/{market}/{code}")
def position_unpin(market: str, code: str):
    """取消某持仓的置顶。"""
    mkt = ds.normalize_market(market)
    db.unpin_position(mkt, code)
    return ok({"market": mkt, "code": code})


# =========================================================
# 交易 & 持仓
# =========================================================
@app.get("/api/transactions")
def transactions(market: Optional[str] = None, code: Optional[str] = None):
    rows = db.get_transactions(market=market, code=code)
    return ok(rows)


@app.post("/api/transactions")
def add_txn(market: str, code: str, side: str, quantity: float,
            price: float, fee: float = 0, trans_date: str = "",
            note: str = ""):
    mkt = ds.normalize_market(market)
    side_u = side.upper()
    if side_u not in ("BUY", "SELL"):
        return fail("方向须为 BUY 或 SELL")
    if quantity <= 0 or price <= 0:
        return fail("数量与价格须为正数")
    if not trans_date:
        trans_date = db.today_str()
    tid = db.add_transaction(mkt, code, side_u, quantity, price, fee, trans_date, note)
    # 录入持仓交易后自动同步到自选标的（实物黄金除外——黄金有独立模块）
    if mkt != "GOLD":
        db.add_watchlist(mkt, code, "")
    return ok({"id": tid})


@app.delete("/api/transactions/{tid}")
def del_txn(tid: int):
    db.delete_transaction(tid)
    return ok()


@app.put("/api/transactions/{tid}")
def update_txn(tid: int, market: Optional[str] = None, code: Optional[str] = None,
               side: Optional[str] = None, quantity: Optional[float] = None,
               price: Optional[float] = None, fee: Optional[float] = None,
               trans_date: Optional[str] = None, note: Optional[str] = None):
    """编辑交易记录（仅更新传入的字段）。"""
    fields = {}
    if market is not None:
        fields["market"] = ds.normalize_market(market)
    if code is not None:
        fields["code"] = str(code)
    if side is not None:
        su = side.upper()
        if su not in ("BUY", "SELL"):
            return fail("方向须为 BUY 或 SELL")
        fields["side"] = su
    if quantity is not None:
        if quantity <= 0:
            return fail("数量须为正数")
        fields["quantity"] = quantity
    if price is not None:
        if price <= 0:
            return fail("价格须为正数")
        fields["price"] = price
    if fee is not None:
        fields["fee"] = fee
    if trans_date is not None:
        fields["trans_date"] = trans_date
    if note is not None:
        fields["note"] = note
    if not fields:
        return fail("没有需要更新的字段")
    db.update_transaction(tid, **fields)
    return ok({"id": tid})


@app.get("/api/positions")
def positions():
    return ok(_positions_data())


def _apply_profit_overrides(p, overrides, holding_pnl, holding_pnl_pct, cum_pnl):
    """应用用户收益覆盖。holding 默认=实时持仓收益，cum 默认=已实现+持仓收益。
    累计收益编辑采用「历史收益基准」联动：
      编辑累计收益时保存 base = 编辑值 - 实时持仓收益；
      展示时 累计收益 = base + 实时持仓收益（随行情自动更新）。"""
    ov = overrides.get((p["market"], p["code"]), {})
    p["holdingPnl"] = round(holding_pnl, 2)
    p["holdingPnlPct"] = holding_pnl_pct
    p["holdingPnlEdited"] = False
    if ov.get("holding") is not None:
        p["holdingPnl"] = round(ov["holding"], 2)
        p["holdingPnlEdited"] = True
    p["cumPnl"] = round(cum_pnl, 2)
    p["cumPnlEdited"] = False
    if ov.get("cum_base") is not None:
        # 累计收益 = 历史收益基准 + 实时持仓收益（随行情自动联动）
        p["cumPnl"] = round(ov["cum_base"] + holding_pnl, 2)
        p["cumPnlEdited"] = True
    elif ov.get("cum") is not None:
        # 兼容旧数据：无历史基准的旧覆盖保持原「总额固定」行为
        p["cumPnl"] = round(ov["cum"], 2)
        p["cumPnlEdited"] = True
    # 兼容旧字段
    p["pnl"] = p["holdingPnl"]
    p["pnl_pct"] = p["holdingPnlPct"]


def _gold_position(realized=None, overrides=None, g=None):
    """构造实物黄金持仓条目。金价不可用返回 None。
    g 可选：调用方已取到的实时金价 dict（避免重复请求）；缺省内部获取。"""
    holding = db.get_gold_holding()
    grams = holding["grams"]
    if grams <= 0:
        return None
    if g is None:
        g = ds.gold_cn_price()
    if not g["available"]:
        return None
    cost_price = holding["cost_price"]
    cost = round(cost_price * grams, 2)
    mv = round(g["price"] * grams, 2)
    holding_pnl = mv - cost
    holding_pnl_pct = round(holding_pnl / cost * 100, 2) if cost else 0
    # 实物黄金已实现收益：来自黄金交易流水（gold_transactions 表，卖出时 (卖价-均价)*克数 累加）。
    # 注意不能从 realized（transactions 表股票/基金）中取——黄金流水在独立表，否则卖出后累计收益会漏掉已实现部分。
    rpnl = db.compute_gold_realized_pnl()
    cum_pnl = rpnl + holding_pnl
    p = {
        "market": "GOLD",
        "code": "GOLD_PHYSICAL",
        "name": "实物黄金（沪金）",
        "quantity": grams,
        "avg_cost": cost_price,
        "cost": cost,
        "price": g["price"],
        "market_value": mv,
        "is_physical_gold": True,
        "data_available": True,
    }
    if overrides is None:
        overrides = db.get_asset_profit_overrides()
    _apply_profit_overrides(p, overrides, holding_pnl, holding_pnl_pct, cum_pnl)
    return p


# =========================================================
# 组合分析
# =========================================================
@app.get("/api/portfolio/summary")
def portfolio_summary():
    # 复用 positions 的计算结果（含用户收益覆盖），保证各界面口径一致
    data = _positions_data()
    total_mv = 0.0
    total_cost = 0.0
    total_holding_pnl = 0.0
    total_cum_pnl = 0.0
    gold_ok = True
    has_gold = False
    for p in data:
        # 已清仓产品 market_value/cost 为 None，用 or 0 兜底（cumPnl/holdingPnl 由 _apply_profit_overrides 设为 0，无 None）
        total_mv += p.get("market_value") or 0
        total_cost += p.get("cost") or 0
        total_holding_pnl += p.get("holdingPnl") or 0
        total_cum_pnl += p.get("cumPnl") or 0
        if p.get("is_physical_gold"):
            has_gold = True
    # 若有实物黄金但金价不可用，positions 未返回该条目 → 按成本计并提示
    holding = db.get_gold_holding()
    if holding["grams"] > 0 and not has_gold:
        cost = round(holding["cost_price"] * holding["grams"], 2)
        total_mv += cost
        total_cost += cost
        gold_ok = False
    total_holding_pct = round(total_holding_pnl / total_cost * 100, 2) if total_cost else 0
    # 每日净值快照（幂等）：当天首次计算组合时写入，供净值曲线/最大回撤使用。
    # 快照口径与组合汇总一致（含实物黄金按成本兜底），随使用自然积累。
    db.ensure_snapshot_today(round(total_mv, 2), round(total_cost, 2), round(total_cum_pnl, 2))
    # 持仓级每日快照（幂等）：同步记录每个持仓当天市值，供收益分析按持仓拆分日/月/年收益。
    pos_snap_items = []
    for p in data:
        if p.get("is_physical_gold"):
            # 实物黄金一次性写入市场市值（GOLD_PHYSICAL）
            pos_snap_items.append(("GOLD", "GOLD_PHYSICAL", p.get("market_value")))
        else:
            pos_snap_items.append((p.get("market"), p.get("code"), p.get("market_value")))
    db.ensure_position_snapshots_today(pos_snap_items)
    # 收益口径锚定当日快照：从快照读回（冻结当日值），保证刷新稳定且基于当前持仓。
    # 当天首次/重算时快照已写入当前持仓收益；之后保持冻结，不再随实时行情跳动。
    snap = db.get_snapshot_today()
    if snap:
        smv = snap.get("total_market_value") or 0
        scost = snap.get("total_cost") or 0
        scum = snap.get("total_cum_pnl")
        if scum is None:
            scum = smv - scost
        total_mv = smv
        total_cost = scost
        total_holding_pnl = round(smv - scost, 2)
        total_cum_pnl = round(scum, 2)
        total_holding_pct = round(total_holding_pnl / total_cost * 100, 2) if total_cost else 0
    return ok({
        "totalMarketValue": round(total_mv, 2),
        "totalCost": round(total_cost, 2),
        "totalHoldingPnl": round(total_holding_pnl, 2),
        "totalHoldingPnlPct": total_holding_pct,
        "totalCumPnl": round(total_cum_pnl, 2),
        # 兼容旧字段
        "totalPnl": round(total_holding_pnl, 2),
        "totalPnlPct": total_holding_pct,
        "goldAvailable": gold_ok,
    })


def _positions_data():
    """返回 positions 的 data 列表（复用收益计算与用户覆盖 + 持仓覆盖）。"""
    def _n(m):
        return ds.normalize_market(m)
    pos = db.compute_positions_including_soldout()
    realized = db.compute_realized_pnl()
    overrides = db.get_asset_profit_overrides()
    po = db.get_position_overrides()  # {(market,code): {quantity, cost}}
    # 应用持仓覆盖：用户手动编辑的数量/成本优先于自动聚合
    if po:
        pos_by_key = {(_n(p["market"]), p["code"]): p for p in pos}
        for key, ov in po.items():
            mk, cd = key
            # v21：实物黄金走 _gold_position 读 gold_holding，不在此应用 override（避免重复黄金行）
            if mk == "GOLD":
                continue
            if ov.get("quantity") is not None and ov["quantity"] <= 0:
                # 数量为0 → 视为删除该持仓
                pos_by_key.pop((mk, cd), None)
                continue
            if ov.get("quantity") is not None and ov.get("cost") is not None:
                qty = ov["quantity"]
                cost = ov["cost"]
                if (mk, cd) in pos_by_key:
                    pos_by_key[(mk, cd)]["quantity"] = qty
                    pos_by_key[(mk, cd)]["cost"] = cost
                    pos_by_key[(mk, cd)]["avg_cost"] = round(cost / qty, 4) if qty > 0 else 0
                    pos_by_key[(mk, cd)]["overridden"] = True
                else:
                    pos_by_key[(mk, cd)] = {
                        "market": mk, "code": cd, "quantity": qty,
                        "avg_cost": round(cost / qty, 4) if qty > 0 else 0,
                        "cost": cost, "overridden": True,
                    }
        pos = list(pos_by_key.values())
    for p in pos:
        if p.get("sold_out"):
            # 已清仓：不拉行情价格（数量/成本/市值置空），但名称仍需展示真实产品名；
            # 尝试从行情取名称（退市标的取不到则回退代码），与正常持仓的 name 行为一致。
            try:
                sym = ds.to_sina_symbol(ds.normalize_market(p["market"]), p["code"])
                q = ds.sina_quotes([sym]).get(sym, {})
                p["name"] = q.get("name") or p["code"]
            except ds.DataSourceError:
                p["name"] = p["code"]
            p["price"] = None
            p["market_value"] = None
            p["data_available"] = True
            p["sold_out"] = True
            rpnl = realized.get((p["market"], p["code"]), 0.0)
            _apply_profit_overrides(p, overrides, 0.0, 0.0, rpnl)
            continue
        sym = ds.to_sina_symbol(ds.normalize_market(p["market"]), p["code"])
        try:
            quotes = ds.sina_quotes([sym])
            q = quotes.get(sym, {})
            price = q.get("price", 0)
            # 基金：市值用单位净值（NAV）计算，而非盘中实时价（v25 需求3）。
            # NAV 每日收盘后才更新——取 NAV 最新一条即「当日已更新用当日、否则自动为前一交易日」。
            if p["market"] == "FUND":
                import re as _re
                fcode = _re.sub(r'^fu_', '', str(p["code"]))
                try:
                    fk = ds.fund_kline(fcode, count=1)
                    if fk["dates"] and fk["ohlc"]:
                        price = fk["ohlc"][-1][1]
                except ds.DataSourceError:
                    price = 0  # NAV 取不到则无法计算基金市值
            mv = price * p["quantity"]
            holding_pnl = mv - p["cost"]
            holding_pnl_pct = round(holding_pnl / p["cost"] * 100, 2) if p["cost"] else 0
            p.update({"name": q.get("name", p["code"]), "price": price,
                      "market_value": round(mv, 2)})
        except ds.DataSourceError:
            # 行情不可用：市值/现价未知，保持 None（不回退成 cost，否则"按市值"排序
            # 会与"按成本"混同、且会虚增组合总市值）；浮动盈亏无法计算置 0。
            p["price"] = None
            p["market_value"] = None
            holding_pnl = 0.0
            holding_pnl_pct = 0.0
            p["data_available"] = False
        else:
            p["data_available"] = True
        rpnl = realized.get((p["market"], p["code"]), 0.0)
        _apply_profit_overrides(p, overrides, holding_pnl, holding_pnl_pct, rpnl + holding_pnl)
    gold = _gold_position(realized=realized, overrides=overrides)
    if gold:
        pos.append(gold)
    return pos


# =========================================================
# 当日收益（总览卡片，v32）
# =========================================================
# 口径（已与用户确认）：实时行情口径 —— 当日收益 = 数量 × (现价 − 昨收基准价)，
# 覆盖 A股/港股/美股/基金/实物黄金等全部持仓。昨日基准：
#   - 股票/指数等：行情源昨收（prev）；
#   - 基金：官方净值已更新到今天 → 用官方昨净值（真实）；官方当日未更新（盘中）
#      → 用新浪 fu_ 估算净值 − 昨官方净值，并标记 estimated=True（估算）；
#   - 实物黄金：昨收金价取 AU0(沪金) 日K前一交易日收盘（真实日K）。
# 行情不可用的持仓不参与加总，计入 missing 列表并提示，绝不填充虚拟数据。
# 当日涨跌幅：股票/指数用行情源 pct；基金/黄金按 (今价−昨收)/昨收 自算。
def _day_prev_quote(sym):
    """取单个新浪行情（含昨收），失败返回 None。"""
    try:
        q = ds.sina_quotes([sym]).get(sym)
        return q if q and q.get("price") else None
    except ds.DataSourceError:
        return None


def _au0_prev_close(today=None):
    """沪金 AU0 日K 前一交易日收盘价（实物黄金「昨收/当日盈亏」基准，元/克）。
    返回最后一根为前收；若最后一根恰为今日（盘中已出现今日K线，极少）则退取上一根。
    取不到返回 None——绝不用虚拟价。"""
    if today is None:
        today = db.today_str()
    try:
        gk = ds.sina_futures_kline("AU0", count=3)
        gdates = gk.get("dates") or []
        gohlc = gk.get("ohlc") or []
        if not gdates or not gohlc:
            return None
        idx = len(gdates) - 1
        if gdates[idx] == today and idx >= 1:
            idx -= 1
        return gohlc[idx][1]
    except ds.DataSourceError:
        return None


def _gold_session_status(g, now=None):
    """国内金价当前交易状态（北京时间，按当前实际金价源 src 的时段表判定）。
    g 为 ds.gold_cn_price() 返回 dict（含 src）。返回 {"status","hint"}；价不可用返回 None。
    周末判定休市；法定节假日无法自动区分 → hint 注明以交易所公告为准（绝不虚报行情）。"""
    if not g.get("available"):
        return None
    src = g.get("src") or "FUT_AU0"
    if now is None:
        now = datetime.now()
    m = now.hour * 60 + now.minute   # 0-1439，北京时间
    wd = now.weekday()               # 0=周一 … 6=周日
    if src == "SGE_AU9999":
        # 上金所 Au99.99 现货：日盘 09:00-11:30 / 13:30-15:30；夜盘 20:00-次日 02:30
        segs = [
            (540, 690, "交易中（日盘）"),
            (690, 810, "午间休市 · 13:30 恢复"),
            (810, 930, "交易中（日盘）"),
            (930, 1200, "日盘已收盘 · 夜盘 20:00 开盘"),
        ]
        night_start, night_label = 1200, "交易中（夜盘）"
        hint = ("Au99.99（上海黄金交易所现货）交易时段：日盘 09:00-11:30 / 13:30-15:30；"
                "夜盘 20:00-次日 02:30。周末及法定节假日休市，以交易所公告为准。")
    else:
        # 沪金连续（上期所黄金期货，当前实际源）：日盘 09:00-10:15 / 10:30-11:30 / 13:30-15:00；夜盘 21:00-次日 02:30
        segs = [
            (540, 615, "交易中（日盘）"),
            (615, 630, "小节休市 · 10:30 恢复"),
            (630, 690, "交易中（日盘）"),
            (690, 810, "午间休市 · 13:30 恢复"),
            (810, 900, "交易中（日盘）"),
            (900, 1260, "日盘已收盘 · 夜盘 21:00 开盘"),
        ]
        night_start, night_label = 1260, "交易中（夜盘）"
        hint = ("沪金连续（上期所黄金期货）交易时段：日盘 09:00-10:15 / 10:30-11:30 / 13:30-15:00；"
                "夜盘 21:00-次日 02:30。周末及法定节假日休市，以交易所公告为准。")
    # 凌晨 00:00-02:30 归前一晚夜盘：仅当「前一自然日为周一~周五」才在交易（周二~周六凌晨）
    if wd in (1, 2, 3, 4, 5) and m < 150:
        return {"status": night_label, "hint": hint}
    if m >= night_start and wd <= 4:   # 当晚夜盘（周一~周五晚开盘，含周五深夜段）
        return {"status": night_label, "hint": hint}
    if wd >= 5:
        return {"status": "周末休市", "hint": hint}
    for a, b, label in segs:           # 周一~周五日盘/收盘窗口
        if a <= m < b:
            return {"status": label, "hint": hint}
    return {"status": "休市", "hint": hint}


def _fund_nav_pair(fcode):
    """基金官方净值相邻对（昨官方净值, 今官方净值）。
    返回 (nav_prev, nav_today, is_today_official)：
      - 官方 NAV 最后一条日期==今天 → (昨日官方, 今日官方, True)
      - 官方 NAV 最后一条日期<今天（盘中未更新）→ (昨官方, None, False)
      - 取不到 → (None, None, False)
    """
    try:
        fk = ds.fund_kline(fcode, count=2)
    except ds.DataSourceError:
        return (None, None, False)
    dates = fk.get("dates") or []
    ohlc = fk.get("ohlc") or []
    if len(dates) < 1 or len(ohlc) < 1:
        return (None, None, False)
    nav_prev = ohlc[-1][1] if len(ohlc) >= 1 else None          # 官方最新（昨/历史最近）
    nav_today = ohlc[-1][1]
    is_today = dates[-1] == db.today_str()
    if is_today and len(ohlc) >= 2:
        nav_prev = ohlc[-2][1]                                   # 官方今日已更新 → 昨日官方
    elif not is_today:
        nav_today = None                                         # 盘中，官方今日未出
    return (nav_prev, nav_today, is_today)


@app.get("/api/portfolio/day-pnl")
def portfolio_day_pnl():
    """当日收益（实时行情口径）：各持仓 数量×(现价−昨收基准) 求和。
    返回 {date, total, count_ok, count_missing, estimated, details[], missing[], note}：
      details: [{market,code,name,quantity,price,prev,pct,pnl,estimated,note}]
      missing: [{market,code,name,reason}]
    正收益红 / 负收益绿由前端按 pnl 符号着色。缺失项绝不填充虚拟值。"""
    data = _positions_data()
    today = db.today_str()
    # 1) 统一收集：过滤已清仓（sold_out）与行情明确不可用的
    rows = []        # (p, sym) 股票类
    fund_rows = []   # (p, fcode) 基金
    gold_pos = None  # 实物黄金持仓
    for p in data:
        if p.get("sold_out"):
            continue  # 已清仓无当日收益
        if p.get("is_physical_gold"):
            gold_pos = p
            continue
        mkt = p.get("market")
        code = p.get("code")
        if not code:
            continue
        if mkt == "FUND":
            fund_rows.append((p, re.sub(r'^fu_', '', str(code))))
        else:
            try:
                rows.append((p, ds.to_sina_symbol(mkt, code)))
            except Exception:
                rows.append((p, str(code)))
    # 2) 股票/指数类：批量新浪行情（一次请求）
    syms = [sym for (_, sym) in rows]
    quotes = {}
    if syms:
        try:
            quotes = ds.sina_quotes(syms)
        except ds.DataSourceError:
            quotes = {}
    # 3) 逐项计算当日收益
    details = []
    missing = []
    total = 0.0
    estimated_flag = False

    def add_detail(p, price, prev, pct, pnl, estimated, note=""):
        nonlocal total, estimated_flag
        if pnl is None or price is None or prev is None:
            return False
        pnl = round(pnl, 2)
        pct = round(pct, 2) if pct is not None else None
        details.append({
            "market": p.get("market"), "code": p.get("code"),
            "name": p.get("name") or p.get("code"),
            "quantity": p.get("quantity"),
            "price": round(price, 4), "prev": round(prev, 4),
            "pct": pct, "pnl": pnl, "estimated": bool(estimated),
            "note": note,
        })
        if estimated:
            estimated_flag = True
        total += pnl
        return True

    # ---- 股票/指数等 ----
    for (p, sym) in rows:
        q = quotes.get(sym)
        name = p.get("name") or p.get("code")
        if not q or not q.get("price"):
            missing.append({"market": p.get("market"), "code": p.get("code"),
                            "name": name, "reason": "实时行情数据暂不可用"})
            continue
        price = q["price"]
        prev = q.get("prev") or 0
        if prev <= 0:
            missing.append({"market": p.get("market"), "code": p.get("code"),
                            "name": name, "reason": "无昨收基准价（新股/停牌等），当日收益无法计算"})
            continue
        qty = p.get("quantity") or 0
        if qty <= 0:
            continue
        pnl = qty * (price - prev)
        # 涨跌幅优先取行情源 pct；无则自算
        pct = q.get("pct")
        if pct is None:
            pct = (price - prev) / prev * 100
        # src_date 非今日 → 该标的最新行情为最近交易日（休市/收盘），note 说明
        src_date = q.get("src_date", "")
        note = ""
        if src_date and src_date.replace("/", "-")[:10] != today:
            note = "最新行情为 %s（最近交易日）" % src_date.replace("/", "-")[:10]
        add_detail(p, price, prev, pct, pnl, False, note)

    # ---- 基金：官方净值优先，盘中用新浪估算（标记估算）----
    for (p, fcode) in fund_rows:
        name = p.get("name") or p.get("code")
        qty = p.get("quantity") or 0
        if qty <= 0:
            continue
        nav_prev, nav_today, is_official_today = _fund_nav_pair(fcode)
        if is_official_today and nav_prev is not None:
            # 官方今日净值已更新 → 真实当日收益
            price = nav_today
            prev = nav_prev
            pnl = qty * (price - prev)
            pct = (price - prev) / prev * 100 if prev else 0
            add_detail(p, price, prev, pct, pnl, False, "官方净值")
            continue
        # 官方当日未更新（盘中/净值未出）→ 新浪 fu_ 估算净值
        fq = _day_prev_quote("fu_" + str(fcode))
        if not fq:
            missing.append({"market": "FUND", "code": p.get("code"),
                            "name": name,
                            "reason": "官方净值今日未更新且估算净值暂不可用（收盘后自动更新）"})
            continue
        price = fq["price"]
        prev = nav_prev if nav_prev is not None else (fq.get("prev") or 0)
        if prev <= 0:
            missing.append({"market": "FUND", "code": p.get("code"), "name": name,
                            "reason": "无昨净值基准，当日收益无法计算"})
            continue
        pnl = qty * (price - prev)
        pct = fq.get("pct")
        if pct is None:
            pct = (price - prev) / prev * 100
        add_detail(p, price, prev, pct, pnl, True, "盘中估算（官方净值收盘后更新）")

    # ---- 实物黄金：今价(实时国内金价) − 昨收(AU0 日K前收) ----
    if gold_pos:
        name = gold_pos.get("name") or "实物黄金（沪金）"
        grams = gold_pos.get("quantity") or 0
        g = ds.gold_cn_price()
        if not (g["available"] and grams > 0):
            missing.append({"market": "GOLD", "code": "GOLD_PHYSICAL", "name": name,
                            "reason": "实时国内金价暂不可用"})
        else:
            prev_gold = _au0_prev_close(today)
            if not prev_gold or prev_gold <= 0:
                missing.append({"market": "GOLD", "code": "GOLD_PHYSICAL", "name": name,
                                "reason": "昨收金价暂不可用（金价日K缺失）"})
            else:
                price = g["price"]
                pnl = grams * (price - prev_gold)
                pct = (price - prev_gold) / prev_gold * 100
                add_detail(gold_pos, price, prev_gold, pct, pnl, False,
                           "昨收取沪金AU0日K前收")

    details.sort(key=lambda x: x["pnl"], reverse=True)
    note = ""
    if estimated_flag:
        note += "含 %d 项基金盘中估算" % sum(1 for d in details if d["estimated"])
    if missing:
        note += ("；" if note else "") + "%d 项行情缺失未计入" % len(missing)
    return ok({
        "date": today,
        "total": round(total, 2) if details else None,
        "count_ok": len(details),
        "count_missing": len(missing),
        "estimated": estimated_flag,
        "details": details,
        "missing": missing,
        "note": note,
    })


def _auto_pnl_for(mkt, code):
    """计算某资产当前的自动持仓收益（实时，不应用用户收益覆盖）。
    实物黄金用 GOLD_PHYSICAL；行情不可用时按 0 处理（累计收益联动退化为基准本身）。"""
    if mkt == "GOLD" and code == "GOLD_PHYSICAL":
        holding = db.get_gold_holding()
        g = ds.gold_cn_price()
        if g["available"] and holding["grams"] > 0:
            return g["price"] * holding["grams"] - holding["cost_price"] * holding["grams"]
        return 0.0
    # 交易聚合持仓 + 持仓覆盖（新增持仓）统一取「市值 - 成本」
    qty = 0.0
    cost = 0.0
    for p in db.compute_positions(market=mkt, code=code):
        qty += p["quantity"]
        cost += p["cost"]
    ov = db.get_position_overrides().get((mkt, code))
    if ov and ov.get("quantity") is not None:
        qty = ov["quantity"]
        cost = ov.get("cost") or cost
    if qty <= 0:
        return 0.0
    sym = ds.to_sina_symbol(mkt, code)
    try:
        price = ds.sina_quotes([sym]).get(sym, {}).get("price", 0)
    except ds.DataSourceError:
        price = 0
    return price * qty - cost


@app.get("/api/portfolio/allocation")
def portfolio_allocation(by: str = "market"):
    """资产分配（饼图）。基于 _positions_data()（含持仓覆盖/新增持仓/实物黄金），
    与组合汇总口径一致，保证「新增持仓」录制的资产也能出现在饼图中。
    每项附带 items：该分组下各产品明细（代码/名称/市值/占该分组百分比），
    供前端点击饼图元素弹窗展示。"""
    pos = _positions_data()
    groups = {}      # key -> {value, items:[(market,code,name,mv)]}
    for p in pos:
        mv = p.get("market_value") or 0
        if mv <= 0:
            continue  # 已清仓/无市值不计入饼图
        key = p["market"] if by == "market" else p["code"]
        g = groups.setdefault(key, {"value": 0.0, "items": []})
        g["value"] += mv
        g["items"].append({
            "market": p["market"],
            "code": p["code"],
            "name": p.get("name") or p["code"],
            "market_value": round(mv, 2),
        })
    result = []
    for k, g in groups.items():
        total = g["value"] or 1
        items = [
            {**it, "pct": round(it["market_value"] / total * 100, 2)}
            for it in g["items"]
        ]
        result.append({"name": k, "value": round(g["value"], 2), "items": items})
    return ok(result)


# =========================================================
# 资产收益编辑
# =========================================================
@app.post("/api/profit")
def save_profit(market: str = Query(..., description="市场标识，如 A/US/HK/GOLD/FUND/BOND"),
                code: str = Query(..., description="代码；实物黄金用 GOLD_PHYSICAL"),
                holding: Optional[float] = Query(None, description="当前持仓收益（编辑覆盖）；缺省则不改"),
                cum: Optional[float] = Query(None, description="累计收益（编辑覆盖）；缺省则不改"),
                clear: Optional[str] = Query(None, description="传 'holding'/'cum'/'all' 清除对应覆盖")):
    """保存用户手动编辑的资产收益。holding/cum 传值即覆盖；clear 用于恢复自动计算。
    编辑累计收益时，把「编辑值 - 当前实时持仓收益」存为历史收益基准，
    之后累计收益 = 历史基准 + 实时持仓收益，随行情自动联动更新。"""
    mkt = ds.normalize_market(market)
    # clear: 'holding'/'cum'/'all' 清除对应字段覆盖
    clear_holding = clear in ("holding", "all")
    clear_cum = clear in ("cum", "all")
    cum_base = None
    if cum is not None and not clear_cum:
        cum_base = round(cum - _auto_pnl_for(mkt, code), 2)
    db.save_asset_profit_override(mkt, code, holding=holding, cum=cum, cum_base=cum_base,
                                  clear_holding=clear_holding, clear_cum=clear_cum)
    ov = db.get_asset_profit_overrides().get((mkt, code), {"holding": None, "cum": None, "cum_base": None})
    return ok({"market": mkt, "code": code, **ov})


# =========================================================
# 收益分析编辑覆盖（v25）
# =========================================================
@app.post("/api/pnl-override")
def save_pnl_override(market: str = Query(..., description="市场标识；组合总收益用 __COMBO__"),
                      code: str = Query(..., description="代码；组合总收益用 __COMBO__"),
                      pnl_type: str = Query(..., description="day/month/year/cum"),
                      range_val: str = Query("", description="范围：day=YYYY-MM-DD/month=YYYY-MM/year=YYYY/cum 空"),
                      detail_pnl: Optional[float] = Query(None, description="该持仓区间收益覆盖值；仅持仓行使用"),
                      combo_pnl: Optional[float] = Query(None, description="组合总收益覆盖值；仅 __COMBO__ 行使用"),
                      clear: Optional[str] = Query(None, description="传 '1' 清除该覆盖")):
    """保存/清除收益分析某「类型+范围」下某持仓（或组合总收益）的收益编辑覆盖。
    market/code 传 __COMBO__ 表示组合总收益；其余为具体持仓。clear='1' 删除覆盖恢复自动计算。"""
    mkt = market if market == db.COMBO_CODE else ds.normalize_market(market)
    c = code  # code 原样存储（持仓代码或 __COMBO__）
    if pnl_type not in ("day", "month", "year", "cum"):
        return fail("pnl_type 须为 day/month/year/cum")
    db.save_pnl_override(mkt, c, pnl_type, range_val or "",
                         detail_pnl=detail_pnl, combo_pnl=combo_pnl, clear=(clear == "1"))
    return ok({"saved": True, "market": mkt, "code": c, "pnl_type": pnl_type, "range_val": range_val or ""})


# =========================================================
# 持仓覆盖（手动编辑数量/成本、删除持仓）
# =========================================================
@app.post("/api/position/override")
def save_position_override(market: str = Query(..., description="市场标识"),
                           code: str = Query(..., description="代码"),
                           quantity: float = Query(..., description="数量；传0表示删除该持仓"),
                           cost: Optional[float] = Query(None, description="总持仓成本；缺省按原成本")):
    """保存某资产的手动持仓数量/成本。quantity<=0 时删除该持仓。
    v21：兼容实物黄金（GOLD）——quantity 即克数、cost 即总成本（元），
    转写成 gold_holding(grams, cost_per_gram) 写入 gold_holding 表（不写 position_override），
    这样 _gold_position 仍从 gold_holding 读克数/成本价，UI 无重复行。
    """
    mkt = ds.normalize_market(market)
    if quantity <= 0:
        if mkt == "GOLD":
            db.save_gold_holding(0, 0)
            return ok({"market": mkt, "code": code, "deleted": True})
        db.delete_position_override(mkt, code)
        return ok({"market": mkt, "code": code, "deleted": True})
    if mkt == "GOLD":
        cp = round(cost / quantity, 4) if quantity > 0 and cost else 0
        db.save_gold_holding(round(quantity, 4), cp)
        return ok({"market": mkt, "code": code, "quantity": quantity, "cost": cp})
    db.save_position_override(mkt, code, quantity, cost if cost is not None else 0)
    return ok({"market": mkt, "code": code, "quantity": quantity, "cost": cost})


@app.delete("/api/position/{market}/{code}")
def delete_position(market: str, code: str):
    """删除某资产持仓：清除覆盖并删除其全部交易记录。"""
    mkt = ds.normalize_market(market)
    db.delete_position_override(mkt, code)
    db.delete_asset_transactions(mkt, code)
    return ok({"market": mkt, "code": code, "deleted": True})


# =========================================================
# 新增持仓（直接录入初始持仓，不用通过交易记录）
#   输入：市场、产品代码、持有金额（当前市值）、持有收益（浮动盈亏）
#   后端：拉当日价格 → 数量=持有金额/价格；成本=持有金额-持有收益
# =========================================================
def _manual_add_one(mkt, code, amount, pnl):
    """单条新增持仓的计算与保存。成功返回 (True, dict)，失败返回 (False, 错误信息)。"""
    code = str(code or "").strip()
    try:
        amount = float(amount)
        pnl = float(pnl if pnl is not None else 0)
    except (TypeError, ValueError):
        return False, "持有金额/收益须为数字"
    if amount <= 0:
        return False, "持有金额须大于 0"
    if not code:
        return False, "请填写产品代码"

    # 拉当日价格（基金用 fu_ 净值，其余用新浪 symbol）
    sym = ds.to_sina_symbol(mkt, code)
    try:
        quotes = ds.sina_quotes([sym])
        q = quotes.get(sym, {})
    except ds.DataSourceError:
        q = {}
    price = q.get("price")
    name = q.get("name", code)
    price_source = "today"  # 标记价格来源（today / last_close）

    if not price or price <= 0:
        # v21：当日无报价（节假日/收盘后/接口受限）→ 回退到最近一个交易日的收盘价
        last, last_date = ds._last_close(mkt, code)
        if last and last > 0:
            price = last
            price_source = "last_close"
        else:
            return False, "无法获取「%s」当日价格" % (name or code)

    # 数量 = 持有金额 / 当日价格；成本 = 持有金额 - 持有收益
    quantity = round(amount / price, 4)
    cost = round(amount - pnl, 2)
    if quantity <= 0:
        return False, "计算出的数量为 0"
    if cost < 0:
        return False, "持有收益不能大于持有金额（成本为负）"

    # 保存持仓覆盖（_positions_data 会自动应用并显示该持仓）
    db.save_position_override(mkt, code, quantity, cost)
    # 新增持仓后自动同步到自选标的（实物黄金除外——黄金有独立模块）
    if mkt != "GOLD":
        db.add_watchlist(mkt, code, name)
    return True, {
        "market": mkt, "code": code, "name": name,
        "price": price, "quantity": quantity, "cost": cost,
        "market_value": round(amount, 2), "pnl": round(pnl, 2),
        "price_source": price_source,  # v21：today=当日价；last_close=回退到最近收盘价
    }


@app.post("/api/position/manual")
def manual_add_position(market: str = Query(..., description="市场标识 A/US/HK/FUND/GOLD/BOND"),
                        code: str = Query(..., description="产品代码"),
                        amount: float = Query(..., description="持有金额（当前市值，元）"),
                        pnl: float = Query(0, description="持有收益（浮动盈亏，元）")):
    """新增初始持仓。用当日价格自动计算数量与成本。"""
    mkt = ds.normalize_market(market)
    ok_flag, result = _manual_add_one(mkt, code, amount, pnl)
    if not ok_flag:
        return fail(result)
    return ok(result)


@app.post("/api/position/manual/batch")
def manual_add_position_batch(items: list = Body(..., description="持仓数组 [{market,code,amount,pnl},...]")):
    """批量新增持仓。items 每项含 market/code/amount(持有金额)/pnl(持有收益)。
    逐条计算并保存，返回每条的成功/失败结果。"""
    if not items:
        return fail("导入列表为空")
    results = []
    success = 0
    failed = 0
    for it in items:
        mkt = ds.normalize_market(it.get("market", "A"))
        code = it.get("code", "")
        amount = it.get("amount", 0)
        pnl = it.get("pnl", 0)
        ok_flag, res = _manual_add_one(mkt, code, amount, pnl)
        if ok_flag:
            success += 1
            results.append({"success": True, "data": res})
        else:
            failed += 1
            results.append({"success": False, "market": mkt, "code": str(code), "error": res})
    return ok({"total": len(items), "success": success, "failed": failed, "results": results})




@app.get("/api/portfolio/performance")
def portfolio_performance(period: str = "all"):
    """组合净值曲线与回撤。
    period: all=全部快照（默认）/ 30=最近30条 / 90=最近90条。
    快照由组合汇总接口每日首次计算时自动写入（snapshots 表，每日一条）。"""
    snaps = db.get_snapshots()
    if period in ("30", "90") and snaps:
        snaps = snaps[-int(period):]
    return ok({
        "dates": [s["snap_date"] for s in snaps],
        "equity": [s["total_market_value"] for s in snaps],
        "cost": [s["total_cost"] for s in snaps],
        "maxDrawdown": ind.max_drawdown([s["total_market_value"] for s in snaps]),
        "totalReturn": ind.total_return([s["total_market_value"] for s in snaps]),
        "count": len(snaps),
    })


@app.get("/api/portfolio/pnl-analysis")
def pnl_analysis(type: str = "day", range_val: str = ""):
    """收益分析：组合级 + 每个持仓在区间内的收益。
    type: day(日) / month(月) / year(年) / cum(累计)
    range:
      - day  -> YYYY-MM-DD（默认今天）
      - month-> YYYY-MM（默认本月）
      - year -> YYYY（默认今年）
      - cum  -> 忽略（全部历史）
    计算口径（v24 修正）：
      - 基本单元「日收益」= 每个相邻交易日对（上一交易日 → 当日）的市值差值。
      - 日收益：仅取「上一个交易日 → 当日」这一对，即所有持仓当日收益的总和。
      - 月/年收益：累加所选范围内每一天的日收益（而非首末差值）。
      - 累计收益：所有持仓产品的累计收益总和（每个持仓 最新市值 − 最早市值，再加总）。
    颜色语义（v24 修正）：红色=赚(正)、绿色=亏(负)。
    返回 {type, range, combo_pnl, combo_pnl_pct, available, note, details:[{market,code,name,pnl}], calendar:[{date,pnl}]}
    """
    snaps = db.get_snapshots()
    if not snaps:
        return ok({"type": type, "range": range_val or "—", "combo_pnl": None, "combo_pnl_pct": None,
                   "available": False, "note": "暂无净值快照，组合分析页每天首次打开会自动记录，积累后才有收益数据",
                   "details": [], "calendar": []})

    today = db.today_str()

    # ---- 选定区间的相邻交易日对（每对 = 上一交易日 → 当日）----
    # pairs: list of (prev_snap, cur_snap)
    def in_range(snap_date: str) -> bool:
        if type == "day":
            return snap_date == (range_val or today)
        if type == "month":
            return snap_date[:7] == (range_val or today[:7])[:7]
        if type == "year":
            return snap_date[:4] == (range_val or today[:4])[:4]
        return True  # cum：全部

    if type == "day":
        # 仅取 ≤ target 的最后两条快照（当日 + 上一个交易日）
        seg = [s for s in snaps if s["snap_date"] <= (range_val or today)]
        if len(seg) < 2:
            return ok({"type": type, "range": range_val or today, "combo_pnl": None, "combo_pnl_pct": None,
                       "available": False, "note": "暂无相邻交易日快照，无法计算日收益（需至少两个交易日的快照）",
                       "details": [], "calendar": []})
        pairs = [(seg[-2], seg[-1])]
        range_label = (range_val or today)
    else:
        if type == "month":
            rng = (range_val or today[:7])[:7]
        elif type == "year":
            rng = (range_val or today[:4])[:4]
        else:
            rng = None
        # 取区间内全部快照（升序），再切相邻对
        seg = [s for s in snaps if in_range(s["snap_date"])]
        if not seg:
            note = "该%s暂无净值快照（历史天数不足或尚未到该周期）" % ("月份" if type == "month" else "年份" if type == "year" else "区间")
            return ok({"type": type, "range": range_val or today, "combo_pnl": None, "combo_pnl_pct": None,
                       "available": False, "note": note, "details": [], "calendar": []})
        pairs = [(seg[i - 1], seg[i]) for i in range(1, len(seg))]
        range_label = (range_val or today[:7]) if type == "month" else (range_val or today[:4]) if type == "year" else ("%s ~ %s" % (seg[0]["snap_date"], seg[-1]["snap_date"]))

    if not pairs:
        return ok({"type": type, "range": range_label, "combo_pnl": None, "combo_pnl_pct": None,
                   "available": False, "note": "区间内无相邻交易日，无法计算收益", "details": [], "calendar": []})

    # ---- 累加「日收益」：组合级 + 每个持仓 ----
    # v27 修复：用户在 day 视图编辑的「日收益」(pnl_override, pnl_type='day', range_val=日期)
    # 视为该日收益单元的最终值，向上聚合到 month/year/cum，并同步到日历图。
    names = { (p.get("market"), p.get("code")): p.get("name") or p.get("code")
              for p in _positions_data() }
    combo_pnl = 0.0
    pos_pnl = {}  # (market, code) -> 区间内日收益累加
    cal = []      # 每日组合收益（日历图用）
    for prev, cur in pairs:
        day_date = cur["snap_date"]
        day_combo = 0.0
        # 每个持仓的当日收益（优先套用 day 类型覆盖，否则用快照差值）
        prev_items = { (m, c): mv for (m, c, mv) in db.get_position_snapshots_on(prev["snap_date"]) }
        cur_items = { (m, c): mv for (m, c, mv) in db.get_position_snapshots_on(day_date) }
        for k in set(prev_items) | set(cur_items):
            pv = prev_items.get(k)
            cv = cur_items.get(k)
            if pv is None or cv is None:
                continue  # 该持仓当天无快照（如行情不可用/新买入），跳过该日以免误导
            base = round(cv - pv, 2)
            # v27：套用该持仓该日的 day 覆盖（编辑日收益联动月/年/累计 + 日历图）
            ov_day = db.get_pnl_override(k[0], k[1], "day", day_date)
            if ov_day and ov_day.get("detail_pnl") is not None:
                base = round(ov_day["detail_pnl"], 2)
            pos_pnl[k] = round(pos_pnl.get(k, 0.0) + base, 2)
            day_combo = round(day_combo + base, 2)
        # v27：套用组合级 day 覆盖（直接设定当日组合收益）
        combo_ov_day = db.get_pnl_override(db.COMBO_CODE, db.COMBO_CODE, "day", day_date)
        if combo_ov_day and combo_ov_day.get("combo_pnl") is not None:
            day_combo = round(combo_ov_day["combo_pnl"], 2)
        combo_pnl = round(combo_pnl + day_combo, 2)
        cal.append({"date": day_date, "pnl": day_combo})

    if type == "day":
        # 区间首末（用于展示 start_date/end_date）
        start_d, end_d = pairs[0][0]["snap_date"], pairs[0][1]["snap_date"]
    else:
        start_d, end_d = pairs[0][0]["snap_date"], pairs[-1][1]["snap_date"]

    # 区间首市值（用于百分比；累计/月年用首末快照的总市值）
    combo_start = next((s["total_market_value"] for s in snaps if s["snap_date"] == start_d), 0)
    combo_pnl_pct = round(combo_pnl / combo_start * 100, 2) if combo_start else 0.0

    # 明细：每个持仓区间内日收益累加（与 combo 自洽）
    details = [{
        "market": k[0], "code": k[1],
        "name": names.get(k, k[1]),
        "pnl": round(v, 2),
    } for k, v in pos_pnl.items()]
    # 套用用户编辑覆盖（每个持仓在某类型+范围下的收益）
    for d in details:
        ov = db.get_pnl_override(d["market"], d["code"], type, range_label)
        if ov and ov.get("detail_pnl") is not None:
            d["pnl"] = round(ov["detail_pnl"], 2)
            d["edited"] = True
    details.sort(key=lambda x: x["pnl"], reverse=True)

    # 组合总收益覆盖（code=__COMBO__）
    combo_ov = db.get_pnl_override(db.COMBO_CODE, db.COMBO_CODE, type, range_label)
    if combo_ov and combo_ov.get("combo_pnl") is not None:
        combo_pnl = round(combo_ov["combo_pnl"], 2)
        combo_edited = True
    else:
        combo_edited = False
    combo_pnl_pct = round(combo_pnl / combo_start * 100, 2) if combo_start else 0.0

    return ok({
        "type": type, "range": range_label,
        "start_date": start_d, "end_date": end_d,
        "combo_pnl": combo_pnl, "combo_pnl_pct": combo_pnl_pct,
        "combo_edited": combo_edited,
        "available": True, "note": "",
        "details": details,
        "calendar": cal,
    })


@app.get("/api/portfolio/pnl-series")
def pnl_series(days: int = 30, kind: str = "holding"):
    """近 N 天每日收益序列（用于总览卡片点击查看详情的折线图）。
    kind: holding（当前持仓收益走势）= 每日 总市值-总成本；cum（累计收益走势）= 每日 累计收益（含已实现，取自快照 total_cum_pnl）。
    返回 {dates, daily_pnl, cumulative_pnl, latest_date}；最右为当前日期，可向左滑动至第一条记录。
    历史点来自每日快照（基于当日当前持仓计算），最右（今日）与总览卡片口径一致。
    """
    snaps = db.get_snapshots()
    if not snaps:
        return ok({"dates": [], "daily_pnl": [], "cumulative_pnl": [], "latest_date": ""})
    recent = snaps[-days:] if len(snaps) >= days else snaps
    dates = [s["snap_date"] for s in recent]
    # 每个快照对应的「当日收益」：holding=市值-成本；cum=累计收益（含已实现），旧快照缺列时回退市值-成本
    vals = []
    for s in recent:
        mv = s.get("total_market_value") or 0
        cost = s.get("total_cost") or 0
        if kind == "holding":
            vals.append(round(mv - cost, 2))
        else:
            cum = s.get("total_cum_pnl")
            vals.append(round(cum if cum is not None else (mv - cost), 2))
    # 每日收益 = 相邻快照之差（走势形状正确，末点变化反映当日截至当前的收益变动）
    daily = [round(vals[i] - vals[i - 1], 2) for i in range(1, len(vals))]
    return ok({
        "dates": dates,
        "daily_pnl": daily,
        "cumulative_pnl": vals,
        "latest_date": dates[-1] if dates else "",
    })# =========================================================
@app.get("/api/reports/export")
def report_export(fmt: str = "csv"):
    # CSV 导出持仓 + 交易
    import io
    import csv
    pos = db.compute_positions()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["market", "code", "quantity", "avg_cost", "cost"])
    for p in pos:
        w.writerow([p["market"], p["code"], p["quantity"], p["avg_cost"], p["cost"]])
    # 实物黄金
    gold = db.get_gold_holding()
    if gold["grams"] > 0:
        w.writerow(["GOLD", "GOLD_PHYSICAL", gold["grams"], gold["cost_price"],
                    round(gold["cost_price"] * gold["grams"], 2)])
    txns = db.get_transactions()
    w.writerow([])
    w.writerow(["date", "market", "code", "side", "quantity", "price", "fee"])
    for t in txns:
        w.writerow([t["trans_date"], t["market"], t["code"], t["side"],
                    t["quantity"], t["price"], t["fee"]])
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse(buf.getvalue(),
                             media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=report.csv"})


# =========================================================
# 数据导入导出（跨机器迁移持仓/自选/交易等全部用户数据）
# 导出文件写入项目根目录固定名「持仓数据_export.json」，用户可下载/拷贝。
# 导入时把该文件放到项目根目录同路径下，调用导入接口即可整体恢复。
# =========================================================
import json as _json

# 项目根目录（app/ 的上级）
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT_FILENAME = "持仓数据_export.json"
EXPORT_FILEPATH = os.path.join(_PROJECT_ROOT, EXPORT_FILENAME)


@app.get("/api/data/export")
def data_export():
    """导出全部用户数据为 JSON 文件（写到项目根目录），并供浏览器下载。"""
    try:
        payload = db.export_all_data()
        data_str = _json.dumps(payload, ensure_ascii=False, indent=2)
        with open(EXPORT_FILEPATH, "w", encoding="utf-8") as f:
            f.write(data_str)
        from fastapi.responses import FileResponse
        return FileResponse(
            EXPORT_FILEPATH,
            media_type="application/json",
            filename=EXPORT_FILENAME,
            headers={"X-Export-Count": str(len(payload["transactions"]) + len(payload["watchlist"]))},
        )
    except Exception as e:
        return fail("导出失败：%s" % str(e))


@app.get("/api/data/export/info")
def data_export_info():
    """查询项目根目录是否存在导出文件及其信息（供导入前预览）。"""
    if not os.path.isfile(EXPORT_FILEPATH):
        return ok({"exists": False, "filename": EXPORT_FILENAME,
                   "path": EXPORT_FILEPATH, "size": 0, "exported_at": "", "items": {}})
    try:
        with open(EXPORT_FILEPATH, "r", encoding="utf-8") as f:
            payload = _json.load(f)
        info = {
            "exists": True,
            "filename": EXPORT_FILENAME,
            "path": EXPORT_FILEPATH,
            "size": os.path.getsize(EXPORT_FILEPATH),
            "exported_at": payload.get("exported_at", ""),
            "items": {
                "watchlist": len(payload.get("watchlist", [])),
                "transactions": len(payload.get("transactions", [])),
                "snapshots": len(payload.get("snapshots", [])),
                "asset_profit": len(payload.get("asset_profit", [])),
                "position_override": len(payload.get("position_override", [])),
                "gold": 1 if (payload.get("gold_holding") or {}).get("grams") else 0,
            },
        }
        return ok(info)
    except Exception as e:
        return fail("读取导出文件失败：%s" % str(e))


@app.post("/api/data/import")
def data_import():
    """导入项目根目录下的导出文件，整体恢复数据库用户数据（会先清空现有数据）。"""
    if not os.path.isfile(EXPORT_FILEPATH):
        return fail("未在项目根目录找到导出文件「%s」，请先把导出文件放到该位置再导入。" % EXPORT_FILENAME)
    try:
        with open(EXPORT_FILEPATH, "r", encoding="utf-8") as f:
            payload = _json.load(f)
        stat = db.import_all_data(payload)
        return ok({"imported": stat, "from": EXPORT_FILENAME,
                   "exported_at": payload.get("exported_at", "")})
    except ValueError as e:
        return fail(str(e))
    except Exception as e:
        return fail("导入失败：%s" % str(e))


# =========================================================
# 财经资讯
# =========================================================
@app.get("/api/news")
def news(keyword: str = "", limit: int = 30):
    try:
        items = ds.sina_news(keyword=keyword, limit=limit)
        # 为每条真实新闻（新浪标题/摘要）附加文本规则分类：市场（国内/国际）+ 行业
        for it in items:
            cls_market, cls_sector = _classify_news(it.get("title", ""), it.get("summary", ""))
            it["market"] = cls_market
            it["sector"] = cls_sector
        return ok(items)
    except ds.DataSourceError as e:
        return fail(str(e))


# 新闻分类规则词典（基于新浪真实标题/摘要关键词，不改原文，仅附加标签）
_NEWS_INTL_KEYWORDS = ["美", "美股", "美联储", "欧洲", "欧股", "日经", "日股", "港股", "恒生",
                       "全球", "关税", "非农", "英伟达", "苹果", "特斯拉", "谷歌", "微软",
                       "国际", "海外", "华尔街", "拜登", "特朗普", "欧洲央行", "日央行", "伦敦"]
_NEWS_SECTOR_RULES = [
    ("芯片", ["芯片", "半导体", "集成电路", "光刻机", "英伟达", "gpu", "ai芯片"]),
    ("新能源", ["新能源", "锂电", "电池", "储能", "碳中和", "电动车", "特斯拉"]),
    ("光伏", ["光伏", "太阳能"]),
    ("医药", ["医药", "疫苗", "创新药", "生物", "医疗", "cxo", "器械"]),
    ("银行", ["银行", "信贷", "存款", "息差", "央行"]),
    ("地产", ["地产", "房地产", "楼市", "房价", "房企", "物业"]),
    ("券商", ["券商", "证券", "投行", "佣金", "两融"]),
    ("白酒", ["白酒", "茅台", "五粮液", "酒"]),
    ("消费", ["消费", "零售", "电商", "食品", "家电", "汽车"]),
    ("能源", ["石油", "原油", "煤炭", "天然气", "石化", "电力"]),
    ("黄金", ["黄金", "黄金股", "贵金属", "白银"]),
    ("科技", ["科技", "互联网", "软件", "人工智能", "ai", "算力", "机器人", "量子"]),
    ("军工", ["军工", "国防", "导弹", "航天"]),
]
_NEWS_SECTOR_DEFAULT = "综合"


def _classify_news(title, summary):
    """基于新闻标题+摘要文本，返回 (market, sector)。
    纯规则匹配，未命中降级为 国内/综合（非虚拟数据）。"""
    text = (title or "") + " " + (summary or "")
    text_lower = text.lower()
    market = "国内"
    # 国际优先：命中任一国际关键词
    for kw in _NEWS_INTL_KEYWORDS:
        if kw.lower() in text_lower:
            market = "国际"
            break
    sector = _NEWS_SECTOR_DEFAULT
    for name, kws in _NEWS_SECTOR_RULES:
        for kw in kws:
            if kw.lower() in text_lower:
                sector = name
                break
        if sector != _NEWS_SECTOR_DEFAULT:
            break
    return market, sector


@app.get("/api/health")
def health():
    return ok({"status": "ok", "time": datetime.now().isoformat()})


# 启动时建表
@app.on_event("startup")
def startup():
    db.init_db()
    db.init_default_indices()  # 首次启动填充内置预置指数
    try:
        itrack.start()  # 启动「无源指数分时」本地跟踪线程（每分钟采样，每交易日重置）
    except Exception:
        pass


# =========================================================
# 静态托管前端（须在所有 /api 路由之后声明，避免拦截 API）
# =========================================================
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend_dist")
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
