# -*- coding: utf-8 -*-
"""
金融工作台 - SQLite 数据库层
自选 / 交易记录 / 净值快照。持仓由交易记录聚合计算。
兼容 Python 3.7。
"""
import os
import sqlite3
from datetime import datetime

DB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
DB_PATH = os.path.join(DB_DIR, "finance.db")


def _connect():
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """建表（幂等）。"""
    conn = _connect()
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS watchlist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            market TEXT NOT NULL,
            code TEXT NOT NULL,
            name TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(market, code)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            market TEXT NOT NULL,
            code TEXT NOT NULL,
            side TEXT NOT NULL,          -- BUY / SELL
            quantity REAL NOT NULL,
            price REAL NOT NULL,
            fee REAL DEFAULT 0,
            trans_date TEXT NOT NULL,
            note TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime'))
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            snap_date TEXT NOT NULL UNIQUE,
            total_market_value REAL DEFAULT 0,
            total_cost REAL DEFAULT 0,
            cash REAL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        )
    """)
    # 持仓级每日快照（收益分析：每个持仓按日市值，用于计算日/月/年/累计收益明细）
    cur.execute("""
        CREATE TABLE IF NOT EXISTS position_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            snap_date TEXT NOT NULL,
            market TEXT NOT NULL,
            code TEXT NOT NULL,
            market_value REAL DEFAULT 0,
            UNIQUE(snap_date, market, code)
        )
    """)
    # 实物黄金：持有克数 + 成本价（元/克）。单行（id=1）。
    cur.execute("""
        CREATE TABLE IF NOT EXISTS gold_holding (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            grams REAL NOT NULL DEFAULT 0,      -- 持有克数
            cost_price REAL NOT NULL DEFAULT 0, -- 成本价（元/克）
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        )
    """)
    cur.execute("INSERT OR IGNORE INTO gold_holding(id, grams, cost_price) VALUES(1, 0, 0)")
    # 实物黄金交易流水：买入/卖出（克数 + 价格），用于加权平均成本与收益计算。
    cur.execute("""
        CREATE TABLE IF NOT EXISTS gold_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            side TEXT NOT NULL,            -- BUY / SELL
            grams REAL NOT NULL,           -- 买卖克数
            price REAL NOT NULL,           -- 成交单价（元/克）
            trans_date TEXT NOT NULL,      -- 成交日期 YYYY-MM-DD
            note TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime'))
        )
    """)
    # 资产收益编辑覆盖：按 (market, code) 存储用户手动编辑的两个收益值。
    # holding_pnl_override: 当前持仓收益覆盖（NULL=用自动计算值）
    # cum_pnl_override: 累计收益覆盖（NULL=用自动计算值）
    # cum_pnl_base_override: 累计收益的「历史（非当前持仓）收益基准」。
    #   用户编辑累计收益时，把「编辑值 - 实时持仓收益」存为历史基准，
    #   展示时 累计收益 = 历史基准 + 实时持仓收益（随行情自动联动）。
    cur.execute("""
        CREATE TABLE IF NOT EXISTS asset_profit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            market TEXT NOT NULL,
            code TEXT NOT NULL,
            holding_pnl_override REAL,
            cum_pnl_override REAL,
            cum_pnl_base_override REAL,
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(market, code)
        )
    """)
    # 兼容旧库：已存在的 asset_profit 表补列（ALTER 幂等，失败说明列已存在则忽略）
    try:
        cur.execute("ALTER TABLE asset_profit ADD COLUMN cum_pnl_base_override REAL")
    except Exception:
        pass
    cur.execute("""
        CREATE TABLE IF NOT EXISTS position_override (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            market TEXT NOT NULL,
            code TEXT NOT NULL,
            quantity REAL,
            cost REAL,
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(market, code)
        )
    """)
    # 持仓置顶：按 (market, code) 标记用户置顶的持仓产品（置顶数量不限）。
    # 持仓管理页展示时置顶的产品永远排在列表最前面。
    cur.execute("""
        CREATE TABLE IF NOT EXISTS pinned_positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            market TEXT NOT NULL,
            code TEXT NOT NULL,
            pinned_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(market, code)
        )
    """)
    # 行情看板指数配置：用户可自定义选择/新增/删除指数。
    # sort_order 控制展示顺序；首次启动自动填充内置预置指数。
    cur.execute("""
        CREATE TABLE IF NOT EXISTS custom_indices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            market TEXT NOT NULL,
            code TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(market, code)
        )
    """)
    # 收益分析编辑覆盖：用户手动修正某「类型+范围」下某持仓的收益值（v25 新增）。
    # pnl_type: day/month/year/cum；range_val: 对应范围（day=YYYY-MM-DD / month=YYYY-MM / year=YYYY / cum 空）。
    # code='__COMBO__' 表示组合总收益覆盖；其余为具体持仓。
    # detail_pnl: 该持仓在区间内的覆盖收益；combo_pnl: 组合总收益覆盖（仅 __COMBO__ 行使用）。
    cur.execute("""
        CREATE TABLE IF NOT EXISTS pnl_override (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            market TEXT NOT NULL,
            code TEXT NOT NULL,
            pnl_type TEXT NOT NULL,
            range_val TEXT NOT NULL DEFAULT '',
            detail_pnl REAL,
            combo_pnl REAL,
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(market, code, pnl_type, range_val)
        )
    """)
    conn.commit()
    conn.close()


# ---------------- 自选 ----------------
def add_watchlist(market, code, name=""):
    conn = _connect()
    try:
        conn.execute("INSERT OR IGNORE INTO watchlist(market,code,name) VALUES(?,?,?)",
                     (market, code, name))
        conn.commit()
    finally:
        conn.close()


def delete_watchlist(wid):
    conn = _connect()
    try:
        conn.execute("DELETE FROM watchlist WHERE id=?", (wid,))
        conn.commit()
    finally:
        conn.close()


def get_watchlist():
    conn = _connect()
    try:
        rows = conn.execute("SELECT * FROM watchlist ORDER BY id").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def delete_asset_transactions(market, code):
    """删除某资产的全部交易记录（用于删除持仓）。"""
    conn = _connect()
    try:
        conn.execute("DELETE FROM transactions WHERE market=? AND code=?", (market, code))
        conn.commit()
    finally:
        conn.close()


# ---------------- 交易记录 ----------------
def add_transaction(market, code, side, quantity, price, fee, trans_date, note=""):
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO transactions(market,code,side,quantity,price,fee,trans_date,note)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (market, code, side, quantity, price, fee, trans_date, note))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def update_transaction(tid, **fields):
    conn = _connect()
    try:
        allowed = {"market", "code", "side", "quantity", "price", "fee", "trans_date", "note"}
        sets, vals = [], []
        for k, v in fields.items():
            if k in allowed:
                sets.append("%s=?" % k)
                vals.append(v)
        if sets:
            vals.append(tid)
            conn.execute("UPDATE transactions SET %s WHERE id=?" % ", ".join(sets), vals)
            conn.commit()
    finally:
        conn.close()


def delete_transaction(tid):
    conn = _connect()
    try:
        conn.execute("DELETE FROM transactions WHERE id=?", (tid,))
        conn.commit()
    finally:
        conn.close()


def get_transactions(market=None, code=None):
    conn = _connect()
    try:
        sql = "SELECT * FROM transactions"
        cond, vals = [], []
        if market:
            cond.append("market=?"); vals.append(market)
        if code:
            cond.append("code=?"); vals.append(code)
        if cond:
            sql += " WHERE " + " AND ".join(cond)
        sql += " ORDER BY trans_date DESC, id DESC"
        rows = conn.execute(sql, vals).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ---------------- 持仓聚合 ----------------
def compute_positions(market=None, code=None):
    """
    根据交易记录用移动加权平均成本计算持仓。
    买入：qty 与 cost（含手续费）累加。
    卖出：按卖出前平均成本扣减 cost，再减 qty（避免成本虚高）。
    返回 [{market, code, quantity, avg_cost, cost}]
    """
    txns = get_transactions(market, code)
    # 必须按 (成交日期, id) 升序重放，保证买入先于卖出；
    # get_transactions 默认按时间倒序（最新在前）用于列表展示，不能直接用于聚合。
    txns = sorted(txns, key=lambda x: (x["trans_date"], x["id"]))
    # 持仓字典: key=(market,code) -> {qty, cost}
    pos = {}
    for t in txns:
        key = (t["market"], t["code"])
        p = pos.setdefault(key, {"qty": 0.0, "cost": 0.0})
        qty = t["quantity"]
        if t["side"] == "BUY":
            p["qty"] += qty
            p["cost"] += qty * t["price"] + t["fee"]
        else:  # SELL
            if p["qty"] > 1e-9 and qty > 0:
                avg = p["cost"] / p["qty"]
                sell_qty = min(qty, p["qty"])
                p["cost"] -= avg * sell_qty
                p["qty"] -= sell_qty
            # 无持仓时卖出记录忽略
    result = []
    for (mkt, cd), p in pos.items():
        if p["qty"] <= 1e-9:
            continue
        avg_cost = p["cost"] / p["qty"] if p["qty"] > 0 else 0
        result.append({
            "market": mkt,
            "code": cd,
            "quantity": round(p["qty"], 4),
            "avg_cost": round(avg_cost, 4),
            "cost": round(avg_cost * p["qty"], 2),
        })
    return result


def compute_positions_including_soldout(market=None, code=None):
    """
    与 compute_positions 相同逻辑，但保留「已卖光」(qty<=1e-9) 的持仓 key，
    用于展示「已清仓」行：数量/成本/均价置空(None)，并标记 sold_out=True，
    其累计收益由 compute_realized_pnl 提供（全部已实现盈亏），仍计入组合整体。
    """
    txns = get_transactions(market, code)
    txns = sorted(txns, key=lambda x: (x["trans_date"], x["id"]))
    pos = {}
    for t in txns:
        key = (t["market"], t["code"])
        p = pos.setdefault(key, {"qty": 0.0, "cost": 0.0})
        qty = t["quantity"]
        if t["side"] == "BUY":
            p["qty"] += qty
            p["cost"] += qty * t["price"] + t["fee"]
        else:  # SELL
            if p["qty"] > 1e-9 and qty > 0:
                avg = p["cost"] / p["qty"]
                sell_qty = min(qty, p["qty"])
                p["cost"] -= avg * sell_qty
                p["qty"] -= sell_qty
    result = []
    for (mkt, cd), p in pos.items():
        if p["qty"] <= 1e-9:
            # 已卖光：保留行，数量/成本置空，标记 sold_out
            result.append({
                "market": mkt,
                "code": cd,
                "quantity": None,
                "avg_cost": None,
                "cost": None,
                "sold_out": True,
            })
            continue
        avg_cost = p["cost"] / p["qty"] if p["qty"] > 0 else 0
        result.append({
            "market": mkt,
            "code": cd,
            "quantity": round(p["qty"], 4),
            "avg_cost": round(avg_cost, 4),
            "cost": round(avg_cost * p["qty"], 2),
            "sold_out": False,
        })
    return result


# ---------------- 净值快照 ----------------
def save_snapshot(snap_date, market_value, cost, cash=0):
    conn = _connect()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO snapshots(snap_date,total_market_value,total_cost,cash)"
            " VALUES(?,?,?,?)",
            (snap_date, market_value, cost, cash))
        conn.commit()
    finally:
        conn.close()


def ensure_snapshot_today(market_value, cost, cash=0):
    """确保今天已有一条净值快照（幂等）。
    组合分析/持仓页每次计算组合时调用：当天首次调用写入，之后不再覆盖，
    保证净值曲线按「每日一条」积累，不会被盘中多次访问刷成多条或覆盖。"""
    snap_date = today_str()
    conn = _connect()
    try:
        row = conn.execute("SELECT id FROM snapshots WHERE snap_date=?", (snap_date,)).fetchone()
        if not row:
            conn.execute(
                "INSERT INTO snapshots(snap_date,total_market_value,total_cost,cash)"
                " VALUES(?,?,?,?)",
                (snap_date, market_value, cost, cash))
            conn.commit()
    finally:
        conn.close()


def get_snapshots():
    conn = _connect()
    try:
        rows = conn.execute("SELECT * FROM snapshots ORDER BY snap_date").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def today_str():
    return datetime.now().strftime("%Y-%m-%d")


# ---------------- 持仓级每日快照（收益分析用） ----------------
def ensure_position_snapshots_today(items):
    """确保今天已写入每个持仓的市值快照（幂等，按 (snap_date,market,code) 唯一）。
    items: [(market, code, market_value), ...]，market_value 为 None 时跳过该持仓当天（行情不可用）。
    组合分析/持仓页每次计算组合时调用：当天首次写入，之后不覆盖，保证按「每日一条」积累。"""
    snap_date = today_str()
    conn = _connect()
    try:
        existing = set(
            (r["market"], r["code"])
            for r in conn.execute(
                "SELECT market,code FROM position_snapshots WHERE snap_date=?", (snap_date,)
            ).fetchall()
        )
        for market, code, mv in items:
            if mv is None:
                continue  # 行情不可用的持仓当天不记快照（避免脏 0）
            if (market, code) in existing:
                continue
            conn.execute(
                "INSERT INTO position_snapshots(snap_date,market,code,market_value)"
                " VALUES(?,?,?,?)",
                (snap_date, market, code, round(float(mv), 2)))
        conn.commit()
    finally:
        conn.close()


def get_position_snapshots(market, code):
    """返回某持仓全部历史快照，按日期升序：[{snap_date, market_value}, ...]"""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT snap_date, market_value FROM position_snapshots"
            " WHERE market=? AND code=? ORDER BY snap_date",
            (market, code)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_position_snapshots_on(snap_date):
    """返回某天所有持仓的市值快照：[(market, code, market_value), ...]"""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT market, code, market_value FROM position_snapshots WHERE snap_date=?",
            (snap_date,)).fetchall()
        return [(r["market"], r["code"], r["market_value"]) for r in rows]
    finally:
        conn.close()


def get_all_position_snapshot_dates():
    """返回所有持仓快照的去重日期列表（升序），用于判断历史覆盖范围。"""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT DISTINCT snap_date FROM position_snapshots ORDER BY snap_date").fetchall()
        return [r["snap_date"] for r in rows]
    finally:
        conn.close()


# ---------------- 实物黄金 ----------------
def get_gold_holding():
    """返回 {grams, cost_price, updated_at}，无记录返回 {grams:0, cost_price:0}"""
    conn = _connect()
    try:
        row = conn.execute("SELECT grams, cost_price, updated_at FROM gold_holding WHERE id=1").fetchone()
        if row:
            return {"grams": row["grams"], "cost_price": row["cost_price"],
                    "updated_at": row["updated_at"]}
        return {"grams": 0.0, "cost_price": 0.0, "updated_at": ""}
    finally:
        conn.close()


def save_gold_holding(grams, cost_price):
    """保存实物黄金克数与成本价（元/克）。返回更新后的记录。"""
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO gold_holding(id, grams, cost_price, updated_at)"
            " VALUES(1,?,?,datetime('now','localtime'))"
            " ON CONFLICT(id) DO UPDATE SET grams=excluded.grams,"
            " cost_price=excluded.cost_price, updated_at=datetime('now','localtime')",
            (grams, cost_price))
        conn.commit()
    finally:
        conn.close()
    return get_gold_holding()


# ---------------- 实物黄金交易流水 ----------------
def add_gold_txn(side, grams, price, trans_date, note=""):
    """录入一笔实物黄金买卖（BUY/SELL，克数 + 价格），并按全部流水重放重建持仓。
    买入加权加仓、卖出按当前平均成本减仓（超卖部分忽略）。
    返回 {txn_id, holding, realized_pnl}。"""
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO gold_transactions(side,grams,price,trans_date,note)"
            " VALUES(?,?,?,?,?)",
            (side, grams, price, trans_date, note))
        txn_id = cur.lastrowid
        conn.commit()
    finally:
        conn.close()
    holding, realized = _rebuild_gold_from_txns()
    return {"txn_id": txn_id, "holding": holding, "realized_pnl": realized}


def delete_gold_txn(tid):
    """删除一笔实物黄金交易，并按剩余流水重放重建持仓。"""
    conn = _connect()
    try:
        conn.execute("DELETE FROM gold_transactions WHERE id=?", (tid,))
        conn.commit()
    finally:
        conn.close()
    holding, realized = _rebuild_gold_from_txns()
    return {"holding": holding, "realized_pnl": realized}


def get_gold_txns():
    """返回全部实物黄金交易流水（按日期升序）。"""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM gold_transactions ORDER BY trans_date, id").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def compute_gold_realized_pnl():
    """按流水顺序计算实物黄金已实现收益（卖出时 (卖价-均价)*克数 累加）。
    与股票持仓的已实现收益口径一致。返回 float。
    v21 修复：改为「纯计算、不写库」——此前复用 _rebuild_gold_from_txns() 会
    把 gold_holding 按流水重放覆盖（无流水时清零），导致用户手动设置/编辑的
    克数与成本价在每次拉取持仓/金价时被重置为 0。"""
    _, realized = _calc_gold_realized_pnl()
    return realized


def _calc_gold_realized_pnl():
    """纯计算：按流水顺序计算实物黄金持仓（克数/成本价）与已实现收益。
    不写库。返回 (holding dict, realized_pnl float)。"""
    txns = get_gold_txns()
    qty = 0.0
    cost = 0.0
    realized = 0.0
    for t in txns:
        g = t["grams"]
        if t["side"] == "BUY":
            qty += g
            cost += g * t["price"]
        else:  # SELL
            if qty > 1e-9 and g > 0:
                avg = cost / qty
                sell = min(g, qty)
                realized += (t["price"] - avg) * sell
                cost -= avg * sell
                qty -= sell
    grams = round(qty, 4)
    cost_price = round(cost / qty, 4) if qty > 1e-9 else 0
    return {"grams": grams, "cost_price": cost_price}, round(realized, 2)


def _rebuild_gold_from_txns():
    """重放全部黄金交易，重建 gold_holding（克数/成本价）并计算已实现收益。
    仅在黄金流水发生增/删时调用（add_gold_txn / delete_gold_txn）。
    返回 (holding dict, realized_pnl)。"""
    holding, realized = _calc_gold_realized_pnl()
    holding = save_gold_holding(holding["grams"], holding["cost_price"])
    return holding, realized


# ---------------- 资产收益编辑覆盖 ----------------
def get_asset_profit_overrides():
    """返回 { (market,code): {"holding": float|None, "cum": float|None, "cum_base": float|None} }
    cum_base 为累计收益的历史（非当前持仓）收益基准；NULL 表示未启用基准联动。"""
    conn = _connect()
    try:
        rows = conn.execute("SELECT market, code, holding_pnl_override, cum_pnl_override, "
                            "cum_pnl_base_override FROM asset_profit").fetchall()
        out = {}
        for r in rows:
            out[(r["market"], r["code"])] = {
                "holding": r["holding_pnl_override"],
                "cum": r["cum_pnl_override"],
                "cum_base": r["cum_pnl_base_override"],
            }
        return out
    finally:
        conn.close()


def save_asset_profit_override(market, code, holding=None, cum=None, cum_base=None,
                               clear_holding=False, clear_cum=False):
    """
    保存某资产的收益编辑覆盖。
    - holding/cum 传数值 → 设置覆盖
    - cum_base 传数值 → 设置累计收益的「历史收益基准」（展示时 累计=基准+实时持仓收益）
    - clear_holding/clear_cum=True → 清除对应字段覆盖（恢复自动计算）
    返回更新后的覆盖 dict {holding, cum, cum_base}（None=无覆盖）。
    """
    conn = _connect()
    try:
        row = conn.execute("SELECT holding_pnl_override, cum_pnl_override, cum_pnl_base_override "
                           "FROM asset_profit WHERE market=? AND code=?",
                           (market, code)).fetchone()
        cur_holding = row["holding_pnl_override"] if row else None
        cur_cum = row["cum_pnl_override"] if row else None
        cur_cum_base = row["cum_pnl_base_override"] if row else None
        if holding is not None:
            cur_holding = holding
        if cum is not None:
            cur_cum = cum
        if cum_base is not None:
            cur_cum_base = cum_base
        if clear_holding:
            cur_holding = None
        if clear_cum:
            cur_cum = None
            cur_cum_base = None
        if cur_holding is None and cur_cum is None and cur_cum_base is None:
            conn.execute("DELETE FROM asset_profit WHERE market=? AND code=?", (market, code))
        else:
            conn.execute(
                "INSERT INTO asset_profit(market, code, holding_pnl_override, cum_pnl_override,"
                " cum_pnl_base_override, updated_at)"
                " VALUES(?,?,?,?,?,datetime('now','localtime'))"
                " ON CONFLICT(market, code) DO UPDATE SET"
                " holding_pnl_override=excluded.holding_pnl_override,"
                " cum_pnl_override=excluded.cum_pnl_override,"
                " cum_pnl_base_override=excluded.cum_pnl_base_override,"
                " updated_at=datetime('now','localtime')",
                (market, code, cur_holding, cur_cum, cur_cum_base))
        conn.commit()
        return {"holding": cur_holding, "cum": cur_cum, "cum_base": cur_cum_base}
    finally:
        conn.close()


def clear_asset_profit_override(market, code):
    """清除某资产的收益编辑覆盖（恢复自动计算）。"""
    conn = _connect()
    try:
        conn.execute("DELETE FROM asset_profit WHERE market=? AND code=?", (market, code))
        conn.commit()
    finally:
        conn.close()


# ---------------- 持仓覆盖（手动编辑数量/成本） ----------------
def get_position_overrides():
    """返回 {(market, code): {quantity, cost}}"""
    conn = _connect()
    try:
        rows = conn.execute("SELECT market,code,quantity,cost FROM position_override").fetchall()
        return {(r["market"], r["code"]): {"quantity": r["quantity"], "cost": r["cost"]} for r in rows}
    finally:
        conn.close()


def save_position_override(market, code, quantity, cost):
    """保存某资产的手动持仓覆盖（quantity 数量、cost 总成本）。"""
    conn = _connect()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO position_override(market,code,quantity,cost,updated_at)"
            " VALUES(?,?,?,?,datetime('now','localtime'))",
            (market, code, quantity, cost))
        conn.commit()
    finally:
        conn.close()


def delete_position_override(market, code):
    """删除某资产的手动持仓覆盖（恢复自动聚合）。"""
    conn = _connect()
    try:
        conn.execute("DELETE FROM position_override WHERE market=? AND code=?", (market, code))
        conn.commit()
    finally:
        conn.close()


# ---------------- 持仓置顶 ----------------
def get_pinned_positions():
    """返回置顶持仓列表 [{market, code, pinned_at}]（按置顶时间升序，先置顶的排前面）。"""
    conn = _connect()
    try:
        rows = conn.execute("SELECT market, code, pinned_at FROM pinned_positions ORDER BY id").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_pinned_set():
    """返回置顶持仓集合 {(market, code)}，供排序时快速判断。"""
    return {(r["market"], r["code"]) for r in get_pinned_positions()}


def set_pin_position(market, code):
    """置顶某持仓（幂等）。"""
    conn = _connect()
    try:
        conn.execute("INSERT OR IGNORE INTO pinned_positions(market,code,pinned_at)"
                     " VALUES(?,?,datetime('now','localtime'))", (market, code))
        conn.commit()
    finally:
        conn.close()


def unpin_position(market, code):
    """取消某持仓的置顶。"""
    conn = _connect()
    try:
        conn.execute("DELETE FROM pinned_positions WHERE market=? AND code=?", (market, code))
        conn.commit()
    finally:
        conn.close()


# ---------------- 行情看板指数配置 ----------------
# 内置预置指数（首次启动自动填充，用户可增删改）
DEFAULT_INDICES = [
    ("上证指数", "A", "sh000001"),
    ("深证成指", "A", "sz399001"),
    ("创业板指", "A", "sz399006"),
    ("科创50", "A", "sh000688"),
    ("沪深300", "A", "sh000300"),
    ("纳斯达克", "US", "ixic"),
    ("标普500", "US", "inx"),
    ("道琼斯", "US", "dji"),
    ("费城半导体", "US", "sox"),
    ("纽约黄金期货", "GOLD", "hf_GC"),  # v21 新增：COMEX 黄金主力
]


def init_default_indices():
    """首次启动时填充内置预置指数（仅当表为空时）。"""
    conn = _connect()
    try:
        row = conn.execute("SELECT COUNT(*) AS n FROM custom_indices").fetchone()
        if row and row["n"] == 0:
            for i, (name, market, code) in enumerate(DEFAULT_INDICES):
                conn.execute("INSERT OR IGNORE INTO custom_indices(name,market,code,sort_order)"
                             " VALUES(?,?,?,?)", (name, market, code, i))
            conn.commit()
    finally:
        conn.close()


def get_custom_indices():
    """返回指数配置列表 [{id, name, market, code, sort_order}]（按 sort_order, id 升序）。"""
    conn = _connect()
    try:
        rows = conn.execute("SELECT * FROM custom_indices ORDER BY sort_order, id").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ---------------- 收益分析编辑覆盖（v25）----------------
COMBO_CODE = "__COMBO__"

def get_pnl_override(market, code, pnl_type, range_val):
    """取某 (market,code,pnl_type,range_val) 的覆盖收益；无则返回 None。"""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT detail_pnl, combo_pnl FROM pnl_override WHERE market=? AND code=? AND pnl_type=? AND range_val=?",
            (market, code, pnl_type, range_val or "")).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def save_pnl_override(market, code, pnl_type, range_val, detail_pnl=None, combo_pnl=None, clear=False):
    """保存/清除某 (market,code,pnl_type,range_val) 的收益覆盖。
    clear=True 时删除该行；否则 upsert（detail_pnl/combo_pnl 为 None 表示该字段不改，但首次写入需给值）。
    """
    conn = _connect()
    try:
        cur = conn.cursor()
        if clear:
            cur.execute(
                "DELETE FROM pnl_override WHERE market=? AND code=? AND pnl_type=? AND range_val=?",
                (market, code, pnl_type, range_val or ""))
            conn.commit()
            return True
        existing = cur.execute(
            "SELECT detail_pnl, combo_pnl FROM pnl_override WHERE market=? AND code=? AND pnl_type=? AND range_val=?",
            (market, code, pnl_type, range_val or "")).fetchone()
        if existing:
            nd = detail_pnl if detail_pnl is not None else existing["detail_pnl"]
            nc = combo_pnl if combo_pnl is not None else existing["combo_pnl"]
            cur.execute(
                "UPDATE pnl_override SET detail_pnl=?, combo_pnl=?, updated_at=datetime('now','localtime')"
                " WHERE market=? AND code=? AND pnl_type=? AND range_val=?",
                (nd, nc, market, code, pnl_type, range_val or ""))
        else:
            cur.execute(
                "INSERT INTO pnl_override(market,code,pnl_type,range_val,detail_pnl,combo_pnl)"
                " VALUES(?,?,?,?,?,?)",
                (market, code, pnl_type, range_val or "", detail_pnl, combo_pnl))
        conn.commit()
        return True
    finally:
        conn.close()


def get_all_pnl_overrides():
    """返回全部覆盖 [{market,code,pnl_type,range_val,detail_pnl,combo_pnl}]，供导入导出。"""
    conn = _connect()
    try:
        rows = conn.execute("SELECT market,code,pnl_type,range_val,detail_pnl,combo_pnl FROM pnl_override").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def add_custom_index(name, market, code):
    """新增一个指数（幂等，重复 (market,code) 忽略）。返回新记录或已存在记录。"""
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT OR IGNORE INTO custom_indices(name,market,code,sort_order)"
            " VALUES(?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM custom_indices))",
            (name, market, code))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def delete_custom_index(idx_id):
    """删除一个指数。"""
    conn = _connect()
    try:
        conn.execute("DELETE FROM custom_indices WHERE id=?", (idx_id,))
        conn.commit()
    finally:
        conn.close()


def swap_index_sort_order(idx_id, dir):
    """与相邻行交换 sort_order。dir='up' 时和前一行交换，'down' 时和后一行交换。
    顶部不能再上移、底部不能再下移（返回 False 表示未移动）。"""
    conn = _connect()
    try:
        row = conn.execute("SELECT id, sort_order FROM custom_indices WHERE id=?", (idx_id,)).fetchone()
        if not row:
            return False
        cur_order = row["sort_order"]
        if dir == "up":
            nxt = conn.execute(
                "SELECT id, sort_order FROM custom_indices WHERE sort_order<? ORDER BY sort_order DESC, id DESC LIMIT 1",
                (cur_order,)).fetchone()
        elif dir == "down":
            nxt = conn.execute(
                "SELECT id, sort_order FROM custom_indices WHERE sort_order>? ORDER BY sort_order ASC, id ASC LIMIT 1",
                (cur_order,)).fetchone()
        else:
            return False
        if not nxt:
            return False
        # 互换 sort_order（用 -1 中转避免 UNIQUE 约束冲突）
        conn.execute("UPDATE custom_indices SET sort_order=-1 WHERE id=?", (row["id"],))
        conn.execute("UPDATE custom_indices SET sort_order=? WHERE id=?", (cur_order, nxt["id"]))
        conn.execute("UPDATE custom_indices SET sort_order=? WHERE id=?", (nxt["sort_order"], row["id"]))
        conn.commit()
        return True
    finally:
        conn.close()


def compute_realized_pnl():
    """
    根据交易记录计算每个资产的历史已实现收益（卖出时的盈利累加）。
    移动加权平均成本：卖出时 (卖出价 - 卖出前平均成本)*卖出量 - 卖出手续费。
    返回 { (market, code): realized_pnl }
    """
    txns = get_transactions()
    # 按资产分组并按时间/id 顺序处理
    assets = {}
    order = {}
    for t in txns:
        key = (t["market"], t["code"])
        assets.setdefault(key, []).append(t)
        if key not in order:
            order[key] = len(order)
    realized = {}
    for key, ts in assets.items():
        # 按 trans_date 和 id 排序（模拟真实买卖顺序）
        ts = sorted(ts, key=lambda x: (x["trans_date"], x["id"]))
        qty = 0.0
        cost = 0.0  # 总成本（含手续费）
        rpnl = 0.0
        for t in ts:
            q = t["quantity"]
            if t["side"] == "BUY":
                qty += q
                cost += q * t["price"] + t["fee"]
            else:  # SELL
                if qty > 1e-9 and q > 0:
                    avg = cost / qty
                    sell_qty = min(q, qty)
                    # 已实现收益 = (卖价-平均成本)*卖出量 - 卖出手续费
                    rpnl += (t["price"] - avg) * sell_qty - t["fee"]
                    cost -= avg * sell_qty
                    qty -= sell_qty
        if abs(rpnl) > 1e-9:
            realized[key] = round(rpnl, 2)
        else:
            realized[key] = 0.0
    return realized


# =========================================================
# 数据导入导出（跨机器迁移持仓/自选/交易等全部用户数据）
# 数据结构：export_all_data() 返回的 dict，import_all_data(payload) 恢复。
# =========================================================
def export_all_data():
    """导出全部用户数据为一个 dict（含版本号，便于导入端校验）。"""
    payload = {
        "app": "finance-workbench",
        "version": 1,
        "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "watchlist": get_watchlist(),
        "transactions": get_transactions(),
        "snapshots": get_snapshots(),
        "gold_holding": get_gold_holding(),
        "gold_transactions": get_gold_txns(),
        "asset_profit": [],
        "position_override": [],
    }
    # asset_profit：转成列表（含 market/code/holding/cum/cum_base 覆盖）
    for (mkt, cd), ov in get_asset_profit_overrides().items():
        payload["asset_profit"].append({
            "market": mkt, "code": cd,
            "holding": ov["holding"], "cum": ov["cum"], "cum_base": ov["cum_base"],
        })
    # position_override：转成列表
    for (mkt, cd), ov in get_position_overrides().items():
        payload["position_override"].append({
            "market": mkt, "code": cd,
            "quantity": ov["quantity"], "cost": ov["cost"],
        })
    # 持仓置顶 + 行情看板指数配置（跨机器迁移保持一致）
    payload["pinned_positions"] = get_pinned_positions()
    payload["custom_indices"] = get_custom_indices()
    # 持仓级每日快照（收益分析模块历史明细，历史天数不可重生，必须导出）
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute("SELECT snap_date, market, code, market_value FROM position_snapshots ORDER BY snap_date, market, code")
        payload["position_snapshots"] = [
            {"snap_date": r[0], "market": r[1], "code": r[2], "market_value": r[3]}
            for r in cur.fetchall()
        ]
        # 收益分析编辑覆盖（v25）
        payload["pnl_override"] = get_all_pnl_overrides()
    finally:
        conn.close()
    return payload


def import_all_data(payload):
    """
    用 payload（export_all_data 的产物）整体恢复数据库用户数据。
    先清空全部用户表，再按 payload 写入，保证与导出时一致。
    返回统计 {watchlist, transactions, snapshots, gold, asset_profit, position_override, position_snapshots}。
    """
    if not isinstance(payload, dict) or payload.get("app") != "finance-workbench":
        raise ValueError("文件不是有效的金融工作台导出文件")
    conn = _connect()
    try:
        cur = conn.cursor()
        # 1) 清空全部用户数据表
        cur.execute("DELETE FROM watchlist")
        cur.execute("DELETE FROM transactions")
        cur.execute("DELETE FROM snapshots")
        cur.execute("DELETE FROM asset_profit")
        cur.execute("DELETE FROM position_override")
        cur.execute("DELETE FROM gold_transactions")
        cur.execute("DELETE FROM pinned_positions")
        cur.execute("DELETE FROM custom_indices")
        cur.execute("DELETE FROM position_snapshots")
        cur.execute("DELETE FROM pnl_override")
        cur.execute("UPDATE gold_holding SET grams=0, cost_price=0, updated_at=datetime('now','localtime') WHERE id=1")

        stat = {
            "watchlist": 0, "transactions": 0, "snapshots": 0,
            "gold": 0, "gold_txns": 0, "asset_profit": 0, "position_override": 0,
        }

        # 2) 自选
        for w in payload.get("watchlist", []):
            cur.execute("INSERT INTO watchlist(market,code,name,created_at) VALUES(?,?,?,?)",
                        (w.get("market", ""), w.get("code", ""),
                         w.get("name", ""), w.get("created_at") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
            stat["watchlist"] += 1

        # 3) 交易记录
        for t in payload.get("transactions", []):
            cur.execute(
                "INSERT INTO transactions(market,code,side,quantity,price,fee,trans_date,note,created_at)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (t.get("market", ""), t.get("code", ""), t.get("side", "BUY"),
                 t.get("quantity", 0), t.get("price", 0), t.get("fee", 0),
                 t.get("trans_date", ""), t.get("note", ""),
                 t.get("created_at") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
            stat["transactions"] += 1

        # 4) 净值快照
        for s in payload.get("snapshots", []):
            cur.execute(
                "INSERT OR REPLACE INTO snapshots(snap_date,total_market_value,total_cost,cash,created_at)"
                " VALUES(?,?,?,?,?)",
                (s.get("snap_date", ""), s.get("total_market_value", 0),
                 s.get("total_cost", 0), s.get("cash", 0),
                 s.get("created_at") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
            stat["snapshots"] += 1

        # 5) 实物黄金
        g = payload.get("gold_holding", {}) or {}
        if g.get("grams"):
            cur.execute(
                "INSERT INTO gold_holding(id, grams, cost_price, updated_at) VALUES(1,?,?,datetime('now','localtime'))"
                " ON CONFLICT(id) DO UPDATE SET grams=excluded.grams, cost_price=excluded.cost_price,"
                " updated_at=datetime('now','localtime')",
                (g.get("grams", 0), g.get("cost_price", 0)))
            stat["gold"] = 1
        # 5.1) 实物黄金交易流水（导入后按流水重放，保证与导出时一致）
        for t in payload.get("gold_transactions", []):
            cur.execute(
                "INSERT INTO gold_transactions(side,grams,price,trans_date,note,created_at)"
                " VALUES(?,?,?,?,?,?)",
                (t.get("side", "BUY"), t.get("grams", 0), t.get("price", 0),
                 t.get("trans_date", ""), t.get("note", ""),
                 t.get("created_at") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
            stat["gold_txns"] += 1

        # 6) 资产收益编辑覆盖
        for p in payload.get("asset_profit", []):
            cur.execute(
                "INSERT INTO asset_profit(market,code,holding_pnl_override,cum_pnl_override,"
                " cum_pnl_base_override,updated_at)"
                " VALUES(?,?,?,?,?,datetime('now','localtime'))",
                (p.get("market", ""), p.get("code", ""),
                 p.get("holding"), p.get("cum"), p.get("cum_base")))
            stat["asset_profit"] += 1

        # 7) 持仓覆盖（手动编辑/新增的持仓）
        for p in payload.get("position_override", []):
            cur.execute(
                "INSERT OR REPLACE INTO position_override(market,code,quantity,cost,updated_at)"
                " VALUES(?,?,?,?,datetime('now','localtime'))",
                (p.get("market", ""), p.get("code", ""),
                 p.get("quantity"), p.get("cost")))
            stat["position_override"] += 1

        # 8) 持仓置顶
        cur.execute("DELETE FROM pinned_positions")
        for p in payload.get("pinned_positions", []):
            cur.execute(
                "INSERT INTO pinned_positions(market,code,pinned_at) VALUES(?,?,?)",
                (p.get("market", ""), p.get("code", ""),
                 p.get("pinned_at") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
        # 9) 行情看板指数配置（导入后若为空则回退内置预置）
        cur.execute("DELETE FROM custom_indices")
        idx_count = 0
        for i, idx in enumerate(payload.get("custom_indices", [])):
            cur.execute(
                "INSERT INTO custom_indices(name,market,code,sort_order,created_at)"
                " VALUES(?,?,?,?,?)",
                (idx.get("name", ""), idx.get("market", "A"), idx.get("code", ""),
                 idx.get("sort_order", i),
                 idx.get("created_at") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
            idx_count += 1
        if idx_count == 0:
            # 旧版本导出文件无指数配置 → 回退内置预置
            for i, (name, market, code) in enumerate(DEFAULT_INDICES):
                cur.execute(
                    "INSERT OR IGNORE INTO custom_indices(name,market,code,sort_order)"
                    " VALUES(?,?,?,?)", (name, market, code, i))
        # 10) 持仓级每日快照（收益分析历史明细，按 (snap_date,market,code) 幂等写入）
        pos_snap_count = 0
        for s in payload.get("position_snapshots", []):
            cur.execute(
                "INSERT OR REPLACE INTO position_snapshots(snap_date,market,code,market_value)"
                " VALUES(?,?,?,?)",
                (s.get("snap_date", ""), s.get("market", ""), s.get("code", ""),
                 s.get("market_value", 0)))
            pos_snap_count += 1
        stat["position_snapshots"] = pos_snap_count
        # 11) 收益分析编辑覆盖（v25，按唯一键幂等写入）
        pnl_ov_count = 0
        for o in payload.get("pnl_override", []):
            cur.execute(
                "INSERT OR REPLACE INTO pnl_override(market,code,pnl_type,range_val,detail_pnl,combo_pnl,updated_at)"
                " VALUES(?,?,?,?,?,?,datetime('now','localtime'))",
                (o.get("market", ""), o.get("code", ""), o.get("pnl_type", ""), o.get("range_val", ""),
                 o.get("detail_pnl"), o.get("combo_pnl")))
            pnl_ov_count += 1
        stat["pnl_override"] = pnl_ov_count
        conn.commit()
        return stat
    finally:
        conn.close()
