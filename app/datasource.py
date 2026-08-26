# -*- coding: utf-8 -*-
"""
金融工作台 - 数据源代理层
统一封装新浪/腾讯/天天基金等免费公开行情接口，输出标准 JSON。
兼容 Python 3.7。
"""
import re
import time
import requests

# 公共请求头
SINA_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://finance.sina.com.cn",
}
TENCENT_HEADERS = {"User-Agent": "Mozilla/5.0"}
EASTMONEY_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://fundf10.eastmoney.com/",
}

_session = requests.Session()
_session.headers.update(SINA_HEADERS)

# ---------------------------------------------------------------
# QDII（合格境内机构投资者）基金代码库
# QDII 基金投资海外市场（美股/港股/日股/德股/原油/黄金/全球资产等），
# 确认份额规则为 T+2（非国内基金），与境内普通基金的 T+1 不同。
# 这里收录常见 QDII 基金代码，用于录入交易时自动识别确认份额规则。
# 说明：QDII 代码段无法用简单前缀完全判定（各基金公司代码段重叠），
# 故用清单 + 前端手动勾选兜底，保证识别准确。
# ---------------------------------------------------------------
QDII_FUND_CODES = set([
    # ---- 美股指数/科技 ----
    "513100", "513500", "513300", "513110",          # 纳指/标普/标普科技/纳指(场内)
    "159941", "161125", "162719", "270042",           # 纳指/标普/纳指(场外)
    "006479", "003722", "040046", "161130",           # 广发纳指/嘉实全球/华安纳指/易方达纳指
    "006373", "006374",                               # 国富纳斯达克100
    "100055",                                         # 富国全球科技
    "005646", "007464", "005698",                     # 汇添富全球消费/广发全球精选/华夏全球科技
    # ---- 港股/恒生 ----
    "159920", "513990", "513990",                     # 恒生ETF / 港股通
    "160924", "118001", "006308", "501021",           # 易方达恒生/华夏港股通/汇添富恒生/港股精选
    "005670", "007107",                               # 摩根亚洲增长/南方香港优选
    # ---- 日经/亚太 ----
    "513520", "513880", "159866",                     # 日经225ETF
    "006408", "000369",                               # 华安日经/广发亚太精选
    # ---- 德国/欧洲 ----
    "513030", "513000",                               # 德国DAX ETF
    "000614", "006308",                               # 华安德国/欧洲精选
    # ---- 原油/能源 ----
    "162411", "161129", "501018",                     # 华宝油气/易方达原油/南方原油
    "160723", "163208",                               # 嘉实原油/诺安油气
    "006476", "007844",                               # 广发原油/原油基金
    # ---- 黄金 QDII（注意：实物黄金/沪金不算 QDII，但下列为 QDII 黄金）----
    "320013", "161116", "000216",                     # 诺安全球黄金/易方达黄金(场外QDII)
    # ---- 全球配置/混合 ----
    "270023", "000834", "005613",                     # 广发全球精选/大成全球/上投摩根全球
    "000041", "160416", "000071",                     # 华夏全球精选/华安标普/华夏恒生
    "241001", "519601", "377016",                     # 华宝海外/海富通海外/上投亚太优势
    "002378", "002379",                               # 建信海外/建信全球
    "164906", "160213",                               # 国泰纳指/泰达全球
    "513090", "513950", "501025",                     # 港股通科技/港股通50/港股蓝筹
    # ---- 补充：更多美股/纳指/标普类 ----
    "513390", "513390", "159501", "013499",           # 纳指100ETF/纳指科技
    "513180", "513160",                               # 恒生科技ETF / 恒生互联网
    "159605", "159606", "513330",                     # 中概互联 / 恒生科技
    "513050",                                         # 中概互联网ETF
    "008763", "012698",                               # 天弘越南市场/华夏纳斯达克100
    "006309", "001061",                               # 汇添富全球移动互联/华夏海外聚享
    "004243", "005885",                               # 广发港股通/美股科技
    "015302", "019309",                               # 华夏全球价值/广发全球价值
    "017515", "016533",                               # 华安纳斯达克/广发恒生科技
    "012173", "012174",                               # 易方达全球成长/广发全球
    "002085", "002086",                               # 国富亚洲/国富全球科技
    # ---- 补充：更多港股/恒生类 ----
    "513060", "513010", "159892",                     # 恒生医疗/恒生科技/恒生生物
    "501303", "006327", "005813",                     # 港股通精选/汇添富恒生科技/华夏恒生科技
    "007151", "012669",                               # 广发港股通成长/华宝港股通
    # ---- 补充：日本/德国/法国/全球地产 ----
    "513910", "513610", "159866",                     # 日经ETF/日经225
    "006598", "020390",                               # 华安日经/天弘日经
    "164815", "006106",                               # 汇添富恒生指数/广发全球精选(港)
    "160121", "000369",                               # 南方金砖/广发亚太
    "070012", "519981",                               # 嘉实海外中国/长信美国标普
    "000988", "160322",                               # 华夏全球房地产/易方达全球
    "513300", "005710",                               # 法国CAC/标普500
    "013485", "017850",                               # 富国全球消费/广发全球医疗
    # ---- 补充：原油/商品/黄金 QDII ----
    "161127", "160216", "018407",                     # 易方达标普/国泰大宗/原油
    "162719", "005524",                               # 广发石油/华安黄金
    "001595", "009894",                               # 天弘越南/黄金ETF联接
    # ---- 补充：其他区域/全球主题 ----
    "013331", "011536", "010090",                     # 嘉实全球/汇添富全球/摩根全球
    "008601", "019479", "019480",                     # 南方全球/华夏全球
    "005341", "004685",                               # 易方达恒生港股通/广发港股通
])

# 前缀启发式：部分基金公司对 QDII 使用专属代码段，可作为清单之外的补充
# （如 006xxx 段中多为 QDII，但不可靠，仅作参考，不参与自动判定）

def is_qdii_fund(fund_code):
    """判断基金代码是否为 QDII（非国内）基金。fund_code 支持 str/int。"""
    c = str(fund_code).strip()
    return c in QDII_FUND_CODES


class DataSourceError(Exception):
    """数据源请求或解析异常"""


def _get(url, headers=None, timeout=12, decode="utf-8"):
    """请求并解码，支持 gbk。返回文本。"""
    try:
        resp = _session.get(url, headers=headers, timeout=timeout)
        resp.raise_for_status()
        raw = resp.content
        if decode == "gbk":
            try:
                return raw.decode("gbk")
            except Exception:
                return raw.decode("utf-8", "ignore")
        return raw.decode("utf-8", "ignore")
    except Exception as exc:
        raise DataSourceError("请求失败: %s" % exc)


def _parse_sina_quote(text):
    """解析新浪 hq_str 格式，返回 dict 或 None。"""
    m = re.match(r'var hq_str_(\w+)="([^"]*)"', text)
    if not m:
        return None
    code, fields = m.group(1), m.group(2)
    if not fields:
        return None
    f = fields.split(",")
    return {"code": code, "fields": f}


# ---------------------------------------------------------------
# 1. A股 / 港股 / 指数 / 黄金 / 基金 通用报价（新浪 hq.sinajs.cn）
# ---------------------------------------------------------------
# 新浪 symbol 规则：
#   A股/指数: sh600519, sh000001, sz399006
#   港股:     hk00700
#   美股:     gb_aapl
#   黄金:     hf_GC(纽约金), nf_AU0(沪金连续), hf_XAU(伦敦金)
#   基金:     fu_161725
def sina_quotes(symbols):
    """批量取新浪报价。symbols: list[str]。返回 {symbol: quote}"""
    if not symbols:
        return {}
    url = "https://hq.sinajs.cn/list=" + ",".join(symbols)
    text = _get(url, headers=SINA_HEADERS, decode="gbk")
    result = {}
    for line in text.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        q = _parse_sina_quote(line)
        if not q or not q["fields"]:
            continue
        sym = q["code"]
        f = q["fields"]
        # 根据前缀判断类型
        if sym.startswith("gb_"):
            # 美股: 名称,现价,涨跌幅,时间,涨跌额,昨收...
            name = f[0]
            price = _float(f[1])
            pct = _float(f[2])
            chg = _float(f[4])
            result[sym] = {
                "name": name, "price": price, "chg": chg, "pct": pct,
                "prev": _float(f[5]) if len(f) > 5 else 0,
            }
        elif sym.startswith("hk"):
            # 港股: 英文名,中文名,今开,昨收,最高,最低,现价,涨跌,涨跌幅...
            name = f[1]
            price = _float(f[6]) if len(f) > 6 else 0
            chg = _float(f[7]) if len(f) > 7 else 0
            pct = _float(f[8]) if len(f) > 8 else 0
            result[sym] = {"name": name, "price": price, "chg": chg, "pct": pct, "prev": _float(f[3]) if len(f) > 3 else 0}
        elif sym.startswith("fu_"):
            # 基金: 名称,时间,现价(净值),昨净值,累计净值,涨跌额,涨跌幅,日期
            name = f[0]
            result[sym] = {
                "name": name, "price": _float(f[2]), "prev": _float(f[3]),
                "chg": _float(f[5]), "pct": _float(f[6]),
                "acc_nav": _float(f[4]) if len(f) > 4 else 0,
                "is_fund": True,
            }
        elif sym.startswith("hf_") or sym.startswith("nf_"):
            # 黄金各品种字段结构不同，针对性解析
            if sym.startswith("nf_"):
                # 沪金连续 nf_AU0: [0]=名称(黄金连续) [4]=昨结? [6]=现价
                # 字段: 名称,时间?,开?,最高?,最低?,昨收?,现价,...
                name = f[0] if f else sym
                # 寻找价格：沪金现价在 index 6
                price = _float(f[6]) if len(f) > 6 else _float(f[4]) if len(f) > 4 else 0
                prev = _float(f[5]) if len(f) > 5 else 0
            else:
                # 纽约金 hf_GC / 伦敦金 hf_XAU: [0]=价格, [13]=名称
                price = _float(f[0]) if f else 0
                name = f[13] if len(f) > 13 else sym
                prev = _float(f[7]) if len(f) > 7 else 0
            chg = round(price - prev, 3) if prev else 0
            pct = round(chg / prev * 100, 2) if prev else 0
            result[sym] = {"name": name, "price": price, "chg": chg, "pct": pct,
                           "prev": prev, "is_gold": True}
        else:
            # A股/指数: 名称,今开,昨收,现价,最高,最低,...
            name = f[0]
            prev = _float(f[2]) if len(f) > 2 else 0
            price = _float(f[3]) if len(f) > 3 else 0
            chg = round(price - prev, 3)
            pct = round(chg / prev * 100, 2) if prev else 0
            result[sym] = {"name": name, "price": price, "chg": chg, "pct": pct, "prev": prev}
    return result


def _float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# 实时国内黄金现价（元/克），用于实物黄金估值。
# 使用新浪沪金主力连续 nf_AU0（上期所黄金期货，报价单位为 元/克）。
GOLD_CN_SYMBOL = "nf_AU0"


def gold_cn_price():
    """
    获取实时国内黄金价格（元/克）。返回 dict:
      {"price": float(元/克), "name": str, "pct": float,
       "asof": "YYYY-MM-DD HH:MM" 最后价格时间, "available": bool}
    获取失败时 available=False（绝不返回虚拟价格）。
    说明：nf_AU0 为上期所黄金期货，日盘 9:00-15:00、夜盘 21:00-次日2:30，
    非交易时段价格保持最近收盘价不变（这是正常的，非 bug）。
    """
    try:
        quotes = sina_quotes([GOLD_CN_SYMBOL])
    except DataSourceError:
        return {"price": 0.0, "name": "沪金连续", "pct": 0.0, "available": False}
    q = quotes.get(GOLD_CN_SYMBOL)
    if not q or not q.get("price"):
        return {"price": 0.0, "name": "沪金连续", "pct": 0.0, "available": False}
    # 解析最后价格时间（f[1]=时间如150000, f[17]=日期如2026-08-24）
    asof = ""
    try:
        text = _get("https://hq.sinajs.cn/list=%s" % GOLD_CN_SYMBOL,
                    headers={"User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn"},
                    decode="gbk")
        m = re.search(r'="(.*?)"', text)
        if m:
            f = m.group(1).split(",")
            hm = f[1].strip() if len(f) > 1 else ""
            d = f[17].strip() if len(f) > 17 else ""
            if len(hm) == 6:
                asof = "%s %s:%s" % (d, hm[0:2], hm[2:4])
            elif d:
                asof = d
    except Exception:
        pass
    return {
        "price": round(q["price"], 2),
        "name": q.get("name", "沪金连续"),
        "pct": q.get("pct", 0.0),
        "prev": q.get("prev", 0.0),
        "asof": asof,
        "available": True,
    }


# ---------------------------------------------------------------
# 2. 腾讯 K线（web.ifzq.gtimg.cn fqkline）
#    symbol: sh600519, usAAPL.OQ, hk00700, sh518880(黄金ETF), nf_AU0
# ---------------------------------------------------------------
def tencent_kline(symbol, period="day", count=120):
    """
    腾讯K线，返回统一格式:
    {"dates": [...], "ohlc": [[open,close,low,high],...], "volume": [...]}
    """
    url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=%s,%s,,,%d,qfq" % (symbol, period, count)
    text = _get(url, headers=TENCENT_HEADERS, decode="utf-8")
    import json
    try:
        data = json.loads(text)
    except Exception:
        raise DataSourceError("K线JSON解析失败")
    node = data.get("data", {}).get(symbol, {})
    # 优先取 qfqday（前复权），否则 day
    rows = node.get("qfqday") or node.get("day") or []
    dates, ohlc, volume = [], [], []
    for row in rows:
        # row: [date, open, close, high, low, volume, ...]
        dates.append(row[0])
        ohlc.append([float(row[1]), float(row[2]), float(row[3]), float(row[4])])
        volume.append(float(row[5]) if len(row) > 5 else 0)
    return {"dates": dates, "ohlc": ohlc, "volume": volume}


# 腾讯 usfqkline 接口支持的美股指数（纳斯达克/标普/道琼斯有完整K线；费城半导体SOX无数据）
def tencent_us_index_kline(symbol, period="day", count=120):
    """
    腾讯美股指数K线（usfqkline 接口）。
    symbol: usIXIC / usINX / usDJI（不带 .OQ）。
    返回统一格式 {"dates","ohlc","volume"}。无数据时返回空列表。
    """
    url = ("https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=%s,%s,,,%d,qfq"
           % (symbol, period, count))
    text = _get(url, headers=TENCENT_HEADERS, decode="utf-8")
    import json
    try:
        data = json.loads(text)
    except Exception:
        raise DataSourceError("美股指数K线JSON解析失败")
    node = data.get("data", {}).get(symbol, {})
    rows = node.get("qfqday") or node.get("day") or []
    dates, ohlc, volume = [], [], []
    for row in rows:
        dates.append(row[0])
        ohlc.append([float(row[1]), float(row[2]), float(row[3]), float(row[4])])
        volume.append(float(row[5]) if len(row) > 5 else 0)
    return {"dates": dates, "ohlc": ohlc, "volume": volume}


# ---------------------------------------------------------------
# 3. 新浪 K线（A股/指数）备选
# ---------------------------------------------------------------
def sina_kline(symbol, scale=240, datalen=120):
    """新浪A股K线。symbol: sh600519 / sz399006。scale: 240日线。"""
    url = ("https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
           "CN_MarketData.getKLineData?symbol=%s&scale=%d&ma=5&datalen=%d" % (symbol, scale, datalen))
    text = _get(url, headers=SINA_HEADERS, decode="utf-8")
    import json
    try:
        data = json.loads(text)
    except Exception:
        raise DataSourceError("新浪K线解析失败")
    dates, ohlc, volume = [], [], []
    for row in data:
        dates.append(row["day"])
        ohlc.append([float(row["open"]), float(row["close"]), float(row["low"]), float(row["high"])])
        volume.append(float(row["volume"]))
    return {"dates": dates, "ohlc": ohlc, "volume": volume}


# ---------------------------------------------------------------
# 3.5 基金 K 线（天天基金单位净值历史）
# ---------------------------------------------------------------
def _fund_net_worth_trend(fund_code):
    """拉取天天基金单位净值历史原始数组。
    返回 [{x: 时间戳ms, y: 单位净值, equityReturn: 日涨跌%}, ...] 或 None。"""
    url = "https://fund.eastmoney.com/pingzhongdata/%s.js" % fund_code
    text = _get(url, headers=EASTMONEY_HEADERS, decode="utf-8")
    m = re.search(r"var Data_netWorthTrend\s*=\s*(\[.*?\]);", text, re.DOTALL)
    if not m:
        return None
    import json
    try:
        rows = json.loads(m.group(1))
    except Exception:
        return None
    return [r for r in rows if r.get("y")]


def fund_kline(fund_code, count=120):
    """
    场外/场内基金的单位净值历史（天天基金 pingzhongdata 接口）。
    基金每日仅一个收盘净值，无盘中 OHLC/成交量，故构造等值 K 线：
      open=high=low=close=当日单位净值（open 用前一日 close，保证有开盘跳空表现）。
    返回统一格式 {"dates","ohlc","volume"}。volume 全为 0。
    """
    rows = _fund_net_worth_trend(fund_code)
    if not rows:
        raise DataSourceError("基金净值数据为空")
    # 取最近 count 天
    rows = rows[-count:]
    dates, ohlc, volume = [], [], []
    prev_close = None
    for r in rows:
        close = float(r["y"])
        d = time.strftime("%Y-%m-%d", time.localtime(r["x"] / 1000))
        # 有前一交易日则用其收盘作为开盘，否则平开
        o = prev_close if prev_close is not None else close
        # 等值K线：最高/最低=当日收盘（基金无盘中价）
        high = max(o, close)
        low = min(o, close)
        dates.append(d)
        ohlc.append([o, close, low, high])
        volume.append(0.0)
        prev_close = close
    return {"dates": dates, "ohlc": ohlc, "volume": volume}


def fund_recent_avg_return(fund_code, n=20):
    """基金近 n 个交易日的平均日涨跌%（取净值历史 equityReturn 的均值）。
    用于低覆盖率穿透时对未覆盖持仓做"中性化"补充，避免把未覆盖部分当 0 涨跌。"""
    rows = _fund_net_worth_trend(fund_code)
    if not rows:
        return None
    rets = []
    for r in rows[-n:]:
        er = r.get("equityReturn")
        if er is not None and er != "":
            try:
                rets.append(float(er))
            except (TypeError, ValueError):
                pass
    if not rets:
        return None
    return round(sum(rets) / len(rets), 4)


# ---------------------------------------------------------------
# 4. 基金详情：前十重仓（天天基金 F10）
# ---------------------------------------------------------------
def fund_holdings(fund_code, topline=10):
    """返回基金前十重仓股 [{code,name,pct,shares,mv}]。

    按行内 td 位置解析，兼容三类持仓行（天天基金 F10 jjcc）：
      - A股：6 位数字代码（如 600519）
      - 美股：字母代码（如 NVDA、AAPL）——QDII/跨境 ETF（纳指/标普等）
      - 港股：5 位数字代码（如 00700）
    行结构：序号 | 代码 | 名称 | 最新价 | 涨跌幅 | 相关资讯 | 占净值比例 | 持股数 | 持仓市值
    """
    url = ("https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc"
           "&code=%s&topline=%d&year=%s" % (fund_code, topline, time.strftime("%Y")))
    text = _get(url, headers=EASTMONEY_HEADERS, decode="utf-8")
    # 天天基金返回的是 JS 包裹的 HTML，需解析
    rows = re.findall(r"<tr>.*?</tr>", text, re.DOTALL)
    holdings = []
    for row in rows[1:]:
        tds = re.findall(r"<td[^>]*>(.*?)</td>", row, re.DOTALL)
        if len(tds) < 9:
            continue

        def _txt(s):
            # 优先取 td 内第一个 <a> 的文本（代码/名称），否则去标签后的纯文本
            m = re.search(r"<a[^>]*>(.*?)</a>", s, re.DOTALL)
            if m:
                return re.sub(r"<[^>]+>", "", m.group(1)).strip()
            return re.sub(r"<[^>]+>", "", s).strip()

        code = _txt(tds[1])
        name = _txt(tds[2])
        if not code or not name:
            continue
        pct_s = re.sub(r"<[^>]+>", "", tds[6]).strip().rstrip("%")
        holdings.append({
            "code": code,
            "name": name,
            "pct": _float(pct_s),
            "shares": re.sub(r"<[^>]+>", "", tds[7]).strip(),
            "market_value": re.sub(r"<[^>]+>", "", tds[8]).strip(),
        })
        # 只取最新一个季度（jjcc 可能返回连续两个季度）
        if len(holdings) >= topline:
            break
    return holdings


# 场内基金标识（ETF/LOF 用基金代码段判断，腾讯/新浪可查场内价格）
_INET_CODE = ("15", "16", "50", "51", "52", "56", "58")


def _is_inmarket_fund(code):
    """粗略判断是否为场内基金（ETF/LOF）。按公募场内代码前缀识别，仅供参考。"""
    return str(code).startswith(_INET_CODE)


def _report_date(fund_code):
    """提取基金季报的持仓截止日期，如 '2026-06-30'。失败返回空串。"""
    url = ("https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc"
           "&code=%s&topline=1&year=%s" % (fund_code, time.strftime("%Y")))
    try:
        text = _get(url, headers=EASTMONEY_HEADERS, decode="utf-8")
        m = re.search(r"截止至：<font[^>]*>([0-9]{4}-[0-9]{2}-[0-9]{2})</font>", text)
        if m:
            return m.group(1)
        m2 = re.search(r"([0-9]{4})年([0-9])季度股票投资明细", text)
        if m2:
            y, q = int(m2.group(1)), int(m2.group(2))
            return "%d-%02d-30" % (y, q * 3)
    except Exception:
        pass
    return ""


def _holding_sym(sc):
    """重仓股代码 → 新浪行情 symbol。
    A股：sh/sz + 6 位代码；港股：hk + 5 位（补前导零）；美股：gb_ + 小写代码。"""
    sc = str(sc).strip()
    if sc.isdigit():
        if len(sc) == 6:
            return ("sh" + sc) if sc.startswith(("6", "9")) else ("sz" + sc)
        return "hk" + sc.zfill(5)  # 港股（如 00700）
    return "gb_" + sc.lower()  # 美股（如 NVDA）


def fund_penetration(fund_code, topline=10):
    """场内基金穿透估算。

    原理：取基金季报前十大重仓股及其占比，用重仓股盘中实时涨跌%加权，
    估算基金当日净值涨跌。返回：
      {
        "code", "name", "nav", "prev", "pct",          # 基金自身行情（新浪 fu_）
        "inmarket": bool, "price": ..., "iopv_pct":...,  # 场内价/估算(若为场内基金)
        "est_pct": 加权估算涨跌%, "est_nav": 估算净值,
        "coverage": 重仓覆盖率%, "report": 报告期(季报),
        "stocks": [ {code,name,pct,price,chg,pctchg,contrib} ],  # 重仓股逐行+对基金贡献
        "available": bool, "unavailable": 原因(失败时)
      }
    """
    try:
        holdings = fund_holdings(fund_code, topline=topline)
    except DataSourceError:
        holdings = []
    if not holdings:
        # 即使拿不到持仓也补基金名称，便于列表展示（不只有代码）
        name = ""
        try:
            q = sina_quotes(["fu_" + str(fund_code)])
            name = q.get("fu_" + str(fund_code), {}).get("name", "")
        except DataSourceError:
            pass
        return {"code": fund_code, "name": name or str(fund_code),
                "available": False, "unavailable": "无法获取持仓数据"}

    # 基金自身行情（新浪 fu_xxxxxx，含实时净值/估值）
    sym = "fu_" + str(fund_code)
    fund_quote = {}
    try:
        q = sina_quotes([sym])
        fund_quote = q.get(sym, {})
    except DataSourceError:
        pass

    # 重仓股实时行情（A股 sh/sz、港股 hk、美股 gb_）
    syms = [_holding_sym(h["code"]) for h in holdings]
    stock_map = {}
    try:
        stock_map = sina_quotes(syms)
    except DataSourceError:
        pass

    # 加权估算涨跌%（用重仓股涨跌幅×占比）
    # 分档策略，显著降低低覆盖率误差：
    #   覆盖率 ≥ 60%  → 直接用已覆盖重仓股的加权涨跌（误差小）
    #   覆盖率 < 60%  → 未覆盖部分不再当作"涨跌0%"，而是用基金自身历史
    #                  近20日均涨跌（中性化动量）填充，避免系统性低估/高估
    est = 0.0
    covered = 0.0
    raw_est = 0.0  # 仅已覆盖重仓的加权涨跌（未校准）
    stocks = []
    for h, s in zip(holdings, syms):
        w = h["pct"]
        q = stock_map.get(s, {})
        pct = q.get("pct")
        if pct is None:
            pct = 0.0
        covered += w
        raw_est += pct * w
        stocks.append({
            "code": h["code"], "name": q.get("name", h["name"]),
            "pct": w, "price": q.get("price"), "chg": q.get("chg"),
            "pctchg": pct, "contrib": round(pct * w / 100.0, 3),  # 对基金涨跌的贡献（%）
            "available": q.get("price") is not None,
        })

    # 低覆盖率处理：用基金历史动量填充未覆盖部分
    est = raw_est
    calib_mode = "direct"
    coverage = round(covered, 2)
    if covered < 60.0 and covered > 0:
        base_ret = fund_recent_avg_return(fund_code, n=20)
        if base_ret is not None:
            uncov = 100.0 - covered  # 未覆盖权重（%）
            est = raw_est + base_ret * uncov  # 未覆盖部分用基金历史均涨跌
            calib_mode = "calibrated"
        else:
            calib_mode = "direct_lowcov"
    elif covered <= 0:
        calib_mode = "no_coverage"

    # 场内基金：额外拉取场内成交价，计算折溢价（场内价 vs 当日单位净值）
    inmarket = _is_inmarket_fund(fund_code)
    market_price = None
    market_pct = None
    premium = None  # 折溢价% = (场内价 - 净值)/净值
    if inmarket:
        c = str(fund_code)
        m_sym = ("sh" + c) if c.startswith(("5", "6", "9")) else ("sz" + c)
        try:
            mq = sina_quotes([m_sym])
            ms = mq.get(m_sym, {})
            market_price = ms.get("price")
            market_pct = ms.get("pct")
            nav_price = fund_quote.get("price")
            if market_price and nav_price:
                premium = round((market_price - nav_price) / nav_price * 100.0, 3)
        except DataSourceError:
            pass

    result = {
        "code": fund_code,
        "name": fund_quote.get("name") or holdings[0]["name"],
        "nav": fund_quote.get("price"),
        "prev": fund_quote.get("prev"),
        "pct": fund_quote.get("pct"),
        "inmarket": inmarket,
        "price": fund_quote.get("price"),
        "market_price": market_price,
        "market_pct": market_pct,
        "premium": premium,
        "est_pct": round(est / 100.0, 3),
        "est_nav": round(fund_quote.get("prev", 0) * (1 + est / 100.0 / 100.0), 4) if fund_quote.get("prev") else None,
        "coverage": coverage,
        "calib_mode": calib_mode,  # direct=高覆盖直接加权 / calibrated=低覆盖历史动量校准 / no_coverage=无覆盖
        "report": _report_date(fund_code),
        "stocks": stocks,
        "available": True,
        "unavailable": "",
    }
    return result


# ---------------------------------------------------------------
# 5.5 A股板块资金流向（东方财富 push2delay，行业板块）
#    真实数据：主力/超大单/大单/中单/小单净流入（单位：元）。
#    说明：push2.eastmoney.com 主域名部分网络不可达，故使用
#    push2delay.eastmoney.com（延迟行情，数据同为当天真实统计）。
# ---------------------------------------------------------------
EASTMONEY_FLOW_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://quote.eastmoney.com/center/gridlist.html",
}
# 板块资金流字段（东方财富 clist 接口）：
#   f12=板块代码  f14=板块名称  f2=板块指数  f3=涨跌幅%
#   f62=主力净流入  f184=主力净流入占比%  f66=超大单净流入  f72=大单净流入
#   f78=中单净流入  f84=小单净流入  f124=更新时间戳
_FLOW_FIELDS = "f12,f14,f2,f3,f62,f184,f66,f72,f78,f84,f124"


def sector_money_flow(top=10):
    """A股行业板块资金流向（当天）。
    返回 {"available": True, "asof": "YYYY-MM-DD HH:MM", "inflow": [...], "outflow": [...]}，
    其中 inflow/outflow 各为 top 条：{code, name, index, pct, main_net(元),
    main_pct, super_net, big_net, mid_net, small_net}。
    获取失败返回 available=False（绝不返回虚拟数据）。"""
    import json as _json
    from datetime import datetime as _dt
    base = ("https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=%d&np=1&fltt=2"
            "&invt=2&fid=f62&fs=m:90+t:2+f:!50&fields=%s")
    out = {"available": False, "asof": "", "inflow": [], "outflow": []}
    try:
        in_text = _get(base % (top, _FLOW_FIELDS) + "&po=1", headers=EASTMONEY_FLOW_HEADERS, decode="utf-8")
        out_text = _get(base % (top, _FLOW_FIELDS) + "&po=0", headers=EASTMONEY_FLOW_HEADERS, decode="utf-8")
        in_data = _json.loads(in_text).get("data", {}).get("diff", [])
        out_data = _json.loads(out_text).get("data", {}).get("diff", [])
    except Exception:
        return out

    def _norm(d):
        ts = d.get("f124")
        return {
            "code": d.get("f12", ""),
            "name": d.get("f14", ""),
            "index": d.get("f2"),
            "pct": d.get("f3"),
            "main_net": d.get("f62"),       # 主力净流入（元）
            "main_pct": d.get("f184"),      # 主力净流入占比（%）
            "super_net": d.get("f66"),      # 超大单净流入（元）
            "big_net": d.get("f72"),        # 大单净流入（元）
            "mid_net": d.get("f78"),        # 中单净流入（元）
            "small_net": d.get("f84"),      # 小单净流入（元）
            "ts": ts,
        }
    out["inflow"] = [_norm(d) for d in in_data]
    out["outflow"] = [_norm(d) for d in out_data]
    # 更新时间（f124 为 Unix 秒级时间戳）
    try:
        ts = out_data[0].get("f124") if out_data else (in_data[0].get("f124") if in_data else None)
        if ts:
            out["asof"] = _dt.fromtimestamp(int(ts)).strftime("%Y-%m-%d %H:%M")
    except Exception:
        pass
    out["available"] = bool(out["inflow"]) or bool(out["outflow"])
    return out


# ---------------------------------------------------------------
# 5. 财经资讯（新浪滚动）
# ---------------------------------------------------------------
def sina_news(keyword="", limit=30):
    """新浪财经滚动新闻。返回 [{title, summary, url, time}]"""
    # 国内财经要闻 lid=2516
    url = ("https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516"
           "&num=%d&order=0" % limit)
    text = _get(url, headers=SINA_HEADERS, decode="utf-8")
    import json
    import datetime as _dt
    try:
        data = json.loads(text)
    except Exception:
        raise DataSourceError("新闻解析失败")
    items = data.get("result", {}).get("data", []) or []
    news = []
    for it in items:
        title = it.get("title") or it.get("subject") or ""
        if keyword and keyword.lower() not in title.lower():
            continue
        # ctime 是 Unix 秒级时间戳，格式化为 YYYY-MM-DD HH:MM
        time_str = ""
        ctime = it.get("ctime")
        if ctime:
            try:
                time_str = _dt.datetime.fromtimestamp(int(ctime)).strftime("%Y-%m-%d %H:%M")
            except Exception:
                time_str = str(ctime)
        news.append({
            "title": title,
            "summary": it.get("summary") or it.get("intro") or "",
            "url": it.get("url") or "",
            "time": time_str,
        })
    return news


# ---------------------------------------------------------------
# 6. 最近一个交易日收盘价（v21 新增）—— sina_quotes 取不到价时回退
#    主要用于 _manual_add_one（新增持仓 / 录入交易）在节假日/收盘后
#    仍能取到一个参考价，避免「无法获取当日价格」错误。
#    基金用 fund_kline（天天基金净值历史，最后一个单位净值）；
#    美股指数用 tencent_us_index_kline；其他用 tencent_kline；
#    腾讯接口偶发 501（间歇性故障）→ 自动重试 3 次；
#    A 股/指数在腾讯失败后追加新浪 K 线兜底。
#    返回 (close_price, date_str) 或 (None, None)。
# ---------------------------------------------------------------
def _last_close(market, code, count=5):
    """取最近一个交易日的收盘价。返回 (close, date_str) 或 (None, None)。"""

    def _try_kline(fn):
        """带重试（腾讯偶发 501）的 K 线调用，成功返回 (close, date)，失败返回 (None, None)。"""
        for attempt in range(3):
            try:
                k = fn()
                if k and k["dates"] and k["ohlc"]:
                    return k["ohlc"][-1][1], k["dates"][-1]
            except DataSourceError:
                pass
            except Exception:
                pass
            if attempt < 2:
                time.sleep(0.3 * (attempt + 1))
        return None, None

    try:
        if market == "FUND":
            return _try_kline(lambda: fund_kline(code, count=count))
        if market == "US":
            c = code.lower()
            # 美股指数走专用接口
            if c in ("ixic", "inx", "dji", "sox", "ndx", "rut", "vix"):
                return _try_kline(lambda: tencent_us_index_kline("us" + c.upper(), count=count))
            return _try_kline(lambda: tencent_kline("us" + c.upper() + ".OQ", count=count))
        sym = to_sina_symbol(market, code)
        r = _try_kline(lambda: tencent_kline(sym, count=count))
        if r[0]:
            return r
        # A 股/指数：腾讯 501 时用新浪 K 线兜底
        if market == "A":
            return _try_kline(lambda: sina_kline(sym, scale=240, datalen=count))
        return r
    except Exception:
        return None, None


# ---------------------------------------------------------------
# 统一入口：根据市场类型解析 symbol → 新浪 symbol
# ---------------------------------------------------------------
def to_sina_symbol(market, code):
    """把 (market, code) 转成新浪 symbol。"""
    market = (market or "").upper()
    code = str(code)
    if market == "A":
        return code  # sh600519 / sz399006 等已是新浪格式
    if market == "US":
        c = code.lower()
        return "gb_" + c
    if market == "HK":
        return "hk" + code
    if market == "GOLD":
        return code  # hf_GC / nf_AU0 / hf_XAU
    if market == "FUND":
        return "fu_" + code
    if market == "BOND":
        return code  # 腾讯处理，新浪返回空
    return code


def normalize_market(market):
    """把中文/英文市场名统一成大写标识。"""
    m = (market or "").strip()
    mapping = {
        "a": "A", "a股": "A", "场内": "A", "指数": "A",
        "us": "US", "美股": "US",
        "hk": "HK", "港股": "HK",
        "gold": "GOLD", "黄金": "GOLD",
        "fund": "FUND", "基金": "FUND",
        "bond": "BOND", "债券": "BOND", "可转债": "BOND",
    }
    return mapping.get(m.lower(), m.upper())
