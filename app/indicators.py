# -*- coding: utf-8 -*-
"""
金融工作台 - 技术指标计算（MA / MACD / 回撤）
纯 Python 实现，无第三方依赖。兼容 Python 3.7。
"""


def simple_ma(closes, n):
    """简单移动平均。返回与 closes 等长的列表，前 n-1 个为 None。"""
    out = []
    total = 0.0
    for i, v in enumerate(closes):
        total += v
        if i >= n:
            total -= closes[i - n]
        window = min(n, i + 1)
        out.append(round(total / window, 3) if window > 0 else None)
    return out


def ema(data, n):
    """指数移动平均。返回与 data 等长。"""
    if not data:
        return []
    k = 2.0 / (n + 1)
    prev = data[0]
    out = [prev]
    for v in data[1:]:
        prev = v * k + prev * (1 - k)
        out.append(prev)
    return out


def macd(closes, fast=12, slow=26, signal=9):
    """MACD。返回 (dif, dea, bar)，各与 closes 等长。bar = (dif-dea)*2。"""
    if not closes:
        return [], [], []
    ema_fast = ema(closes, fast)
    ema_slow = ema(closes, slow)
    dif = [a - b for a, b in zip(ema_fast, ema_slow)]
    dea = ema(dif, signal)
    bar = [(d - e) * 2 for d, e in zip(dif, dea)]
    return ([round(x, 3) for x in dif],
            [round(x, 3) for x in dea],
            [round(x, 3) for x in bar])


def max_drawdown(equity):
    """最大回撤(%)。equity: list[float]。返回负百分比，如 -8.32。"""
    if not equity:
        return 0.0
    peak = equity[0]
    max_dd = 0.0
    for v in equity:
        if v > peak:
            peak = v
        if peak > 0:
            dd = (v - peak) / peak * 100
            if dd < max_dd:
                max_dd = dd
    return round(max_dd, 2)


def total_return(equity):
    """总收益率(%)。"""
    if not equity or equity[0] == 0:
        return 0.0
    return round((equity[-1] - equity[0]) / equity[0] * 100, 2)
