import React, { useState, useEffect, useCallback, useRef } from 'react'
import EChart from './EChart.jsx'
import { api } from '../api.js'

// ---------------------------------------------------------------------------
// K 线配色：唯一来源。
// 「图例（筛选按钮）图标颜色」与「实际划线 / 柱体颜色」共用同一份常量，
// 避免两处各写一份导致颜色漂移（v31 修复：此前 legend 图标取 ECharts 默认
// 调色板色，与 lineStyle / itemStyle 的实际渲染色完全不一致）。
// 配色规则与全站一致：红涨绿跌。
// ---------------------------------------------------------------------------
export const KL_COLORS = {
  up: '#f85149',                    // 涨：阳线 / MACD 正柱
  down: '#3fb950',                  // 跌：阴线 / MACD 负柱
  volumeUp: 'rgba(248,81,73,.7)',   // 成交量（上涨）
  volumeDown: 'rgba(63,185,80,.7)', // 成交量（下跌）
  ma5: '#d29922',                   // MA5
  ma10: '#58a6ff',                  // MA10
  ma20: '#a371f7',                  // MA20
  dif: '#58a6ff',                   // MACD DIF
  dea: '#d29922',                   // MACD DEA
  buy: '#ff8c00',                   // 买卖点标注：买入
  sell: '#1e90ff',                  // 买卖点标注：卖出
  inactive: '#ccc',                 // 图例取消选中时的灰显色（与 ECharts 默认 inactiveColor 一致）
  intraPrice: '#e6edf3',            // 当日分时：价格线（近白，深色主题可读）
  intraAvg: '#f2c230',              // 当日分时：均价线（行业惯例黄色）
  base: '#8b949e',                  // 昨收基准线 / 通用灰
}

// 双色图例图标：K线 / 成交量 / MACD 三者在图上是「红涨绿跌」双色渲染，单个色块
// 无法同时表达两种颜色，故用自定义 SVG 表达完整语义（左=红涨，右=绿跌）。
// inactive=true 时整体转灰，与单色系列「取消选中即置灰」的行为保持一致
// （image 图标 ECharts 不会自动置灰，需由 legendselectchanged 手动切换）。
function dualColorIcon(kind, inactive) {
  const up = inactive ? KL_COLORS.inactive : KL_COLORS.up
  const down = inactive ? KL_COLORS.inactive : KL_COLORS.down
  // kind='candle'：两支小蜡烛（左红涨 / 右绿跌）；其他：两根柱（左红涨 / 右绿跌）
  const body = kind === 'candle'
    ? `<rect x="3" y="1" width="1" height="14" fill="${up}"/>`
      + `<rect x="1" y="4" width="5" height="7" fill="${up}"/>`
      + `<rect x="12" y="1" width="1" height="14" fill="${down}"/>`
      + `<rect x="10" y="3" width="5" height="9" fill="${down}"/>`
    : `<rect x="1" y="4" width="5" height="12" fill="${up}"/>`
      + `<rect x="10" y="7" width="5" height="9" fill="${down}"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${body}</svg>`
  return 'image://data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

// 图例项：单色系列用 itemStyle.color 精确对齐实际划线色；
// 双色系列用双色 SVG 图标，并按未选中集合切换为灰版。
const buildLegendData = (unselected) => [
  { name: 'K线', icon: dualColorIcon('candle', unselected.has('K线')) },
  { name: 'MA5', itemStyle: { color: KL_COLORS.ma5 } },
  { name: 'MA10', itemStyle: { color: KL_COLORS.ma10 } },
  { name: 'MA20', itemStyle: { color: KL_COLORS.ma20 } },
  { name: '成交量', icon: dualColorIcon('bar', unselected.has('成交量')) },
  { name: 'DIF', itemStyle: { color: KL_COLORS.dif } },
  { name: 'DEA', itemStyle: { color: KL_COLORS.dea } },
  { name: 'MACD', icon: dualColorIcon('bar', unselected.has('MACD')) },
]

const NO_UNSELECTED = new Set()

// ---------------------------------------------------------------------------
// 周期切换栏（v31）
// 分时=当日分时走势（A股/港股真实源）；m1~m60=分钟K（仅A股真实源）；
// 日K/周K/月K/年K=长历史K线（前复权；年K由真实月K聚合）。
// ---------------------------------------------------------------------------
const PERIOD_TABS = [
  { key: 'minute', label: '分时' },
  { key: 'm1', label: '1分' }, { key: 'm5', label: '5分' },
  { key: 'm15', label: '15分' }, { key: 'm30', label: '30分' }, { key: 'm60', label: '60分' },
  { key: 'day', label: '日K' }, { key: 'week', label: '周K' },
  { key: 'month', label: '月K' }, { key: 'year', label: '年K' },
]
const PERIOD_LABEL = PERIOD_TABS.reduce((m, t) => { m[t.key] = t.label; return m }, {})
// 各周期拉取根数：对齐真实数据源上限（个股前复权日K约640根/2.6年，指数/港股约1000根/4年；
// 周K 640根≈12年；月K 500根≈25-36年全量；年K 60年=月K聚合的实际上市年数）
const PERIOD_CNT = { day: 1000, week: 640, month: 500, year: 60,
                     m1: 240, m5: 240, m15: 240, m30: 240, m60: 240 }

// ---------------------------------------------------------------------------
// K线默认视野（v32）：按周期对齐「自然日期窗口」，所有标的（指数/个股/基金/港股
// 等）统一生效。数据仍按 PERIOD_CNT 拉满（可拖动回看更早历史），打开时仅默认
// 聚焦最近窗口：
//   日K → 近 6 个月   周K → 近 1 年半（18 个月）
//   月K → 近 5 年（60 个月）   年K → 近 10 年（120 个月）
// 从「最后一根K线日期」向前回推 N 个月得到 cutoff，取首个日期 ≥ cutoff 的K线为
// 视野起点（窗口随最新数据自动平移）；历史不足窗口长度时自动显示全部。
// 分钟K（m1~m60）无「日期窗口」语义，维持原固定比例视野（start:40）。
// ---------------------------------------------------------------------------
const PERIOD_VIEW_MONTHS = { day: 6, week: 18, month: 60, year: 120 }

function buildDefaultZoom(period, dates) {
  const months = PERIOD_VIEW_MONTHS[period]
  if (!months || !dates || dates.length < 2) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dates[dates.length - 1]).slice(0, 10))
  if (!m) return null
  // 最新K线日期向前回推 N 个月（Date 自动处理月份溢出与跨年）
  const cut = new Date(+m[1], +m[2] - 1 - months, +m[3])
  const pad = (n) => String(n).padStart(2, '0')
  const cutoff = cut.getFullYear() + '-' + pad(cut.getMonth() + 1) + '-' + pad(cut.getDate())
  let start = 0
  for (let i = 0; i < dates.length; i++) {
    if (String(dates[i]).slice(0, 10) >= cutoff) { start = i; break }
  }
  if (start >= dates.length) start = dates.length - 1
  return { startValue: start, endValue: dates.length - 1 }
}

// 分时走势视图（ECharts）：价格线 + 均价线 + 昨收基准 + 底部量柱（红涨绿跌）
// 说明：
// - 均价线仅个股/港股显示（指数无"均价"概念，后端 avg 为 null）；
// - 成交量柱为"当分钟量"（腾讯原始为累计值，后端已差分）；
// - 数据可能来自 腾讯当日实时 / 东财最近交易日 / 本地跟踪文件（v31 三源链），
//   trade_date 非今日时顶部提示"最近交易日"日期，避免与当日混淆。
function IntradayView({ data }) {
  const { times, price, avg_price, volume, prev_close, trade_date, source } = data
  const last = price[price.length - 1]
  const pc = (prev_close != null && prev_close > 0) ? prev_close : price[0]
  const up = last >= pc
  const lineColor = up ? KL_COLORS.up : KL_COLORS.down
  const hasAvg = !!(avg_price && avg_price.some((v) => v != null))
  // y 轴以昨收为中心对称（主流分时图惯例）
  const spread = Math.max(...price.map((v) => Math.abs(v - pc)), 0.01)
  const fmt = (v) => (v >= 1e8 ? (v / 1e8).toFixed(1) + '亿' : v >= 1e4 ? (v / 1e4).toFixed(0) + '万' : v)
  const today = new Date()
  const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0')
  const notToday = trade_date && trade_date !== todayStr
  const srcLabel = source === 'tencent' ? '腾讯实时' : source === 'eastmoney' ? '东方财富' : source === 'local' ? '本地跟踪' : '行情'
  const legendData = [{ name: '价格', itemStyle: { color: lineColor } }]
  if (hasAvg) legendData.push({ name: '均价', itemStyle: { color: KL_COLORS.intraAvg } })
  const series = [
    {
      name: '价格', type: 'line', xAxisIndex: 0, yAxisIndex: 0,
      data: price, symbol: 'none', lineStyle: { color: lineColor, width: 1.4 },
      markLine: pc ? {
        silent: true, symbol: 'none',
        lineStyle: { color: KL_COLORS.base, type: 'dashed', width: 1 },
        label: { show: true, formatter: '昨收 ' + pc.toFixed(2), color: KL_COLORS.base, position: 'insideEndTop', fontSize: 10 },
        data: [{ yAxis: pc }],
      } : undefined,
    },
  ]
  if (hasAvg) {
    series.push({
      name: '均价', type: 'line', xAxisIndex: 0, yAxisIndex: 0,
      data: avg_price, symbol: 'none', lineStyle: { color: KL_COLORS.intraAvg, width: 1.2 },
    })
  }
  // 底部量柱（当分钟量）：单点价 vs 昨收 红涨绿跌；不入图例（legend.data 已显式限定）
  series.push({
    name: '量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1,
    data: volume.map((v, i) => ({ value: v, itemStyle: { color: price[i] >= pc ? KL_COLORS.volumeUp : KL_COLORS.volumeDown } })),
    barWidth: '60%',
  })
  const option = {
    animation: false,
    tooltip: {
      trigger: 'axis',
      formatter: (ps) => {
        const i = ps[0] ? ps[0].dataIndex : 0
        const t = times[i]
        const p = price[i]
        const pct = pc ? ((p - pc) / pc * 100).toFixed(2) : '--'
        const rows = [
          `<div style="font-weight:bold;margin-bottom:4px">${t}</div>`,
          `<div>价格：<b style="color:${p >= pc ? KL_COLORS.up : KL_COLORS.down}">${p.toFixed(2)}</b>　<span style="color:${p >= pc ? KL_COLORS.up : KL_COLORS.down}">${p >= pc ? '+' : ''}${pct}%</span></div>`,
        ]
        if (hasAvg && avg_price[i] != null) rows.push(`<div>均价：${avg_price[i].toFixed(2)}</div>`)
        if (volume && volume[i] != null) rows.push(`<div>成交量：${fmt(volume[i])}股</div>`)
        if (pc) rows.push(`<div style="color:#8b949e">昨收：${pc.toFixed(2)}</div>`)
        return rows.join('')
      },
    },
    legend: {
      // 图例色显式对齐实际线色（沿用 v31 图例颜色规范）
      data: legendData,
      textStyle: { color: '#8b949e' }, top: 0, itemWidth: 14, itemHeight: 14,
    },
    grid: [
      { left: 70, right: 20, top: 30, height: '58%' },
      { left: 70, right: 20, top: '72%', height: '18%' },
    ],
    xAxis: [
      { type: 'category', gridIndex: 0, data: times, axisLabel: { color: '#8b949e' }, axisLine: { lineStyle: { color: '#2a3040' } } },
      { type: 'category', gridIndex: 1, data: times, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#2a3040' } } },
    ],
    yAxis: [
      {
        gridIndex: 0, scale: false,
        min: pc - spread * 1.05, max: pc + spread * 1.05,
        axisLabel: { color: '#8b949e' }, splitLine: { lineStyle: { color: 'rgba(42,48,64,.4)' } },
      },
      { gridIndex: 1, scale: true, axisLabel: { color: '#8b949e', formatter: fmt }, splitLine: { show: false } },
    ],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 }],
    series,
  }
  // 量柱不入图例（避免与 K 线「成交量」图例混淆），legend 仅价格/均价可开关
  return (
    <>
      <div className="kline-period-tip" style={{ padding: '2px 0 0 64px', fontSize: 11, color: '#8b949e' }}>
        分时（数据源：{srcLabel}；{notToday ? ('数据日期 ' + trade_date + '（最近交易日），' + (source === 'eastmoney' ? '美股/海外指数在其休市时段显示上一交易日分时' : '本地跟踪记录在交易日自动重置')) : '当日逐分钟'}）
      </div>
      <EChart option={option} className="chart-md" style={{ height: 660 }} />
    </>
  )
}

// K线 / 分钟K 视图：蜡烛 + MA + 成交量 + MACD（红涨绿跌；买卖点标注仅日K及以上周期）
function KlineView({ kdata, markers, period }) {
  const chartRef = useRef(null)
  const { dates, ohlc, volume, ma5, ma10, ma20, macdDIF, macdDEA, macdBAR, proxied, proxy_note } = kdata
  const pLabel = PERIOD_LABEL[period] || period
  const isMinute = /^m\d+$/.test(period)
  const isKPeriod = ['day', 'week', 'month', 'year'].includes(period)
  // x 轴标签：分钟K显示 HH:MM，日/周/月/年显示 MM-DD
  const xFmt = (v) => {
    const s = String(v || '')
    return s.length > 10 ? s.slice(11, 16) : s.slice(5)
  }

  // 将用户录入的买卖时间点对齐到 K 线最近交易日（ISO 日期可按字典序比较），并在 K 线面板
  // 顶部用竖直虚线画到与 K 线交叉处，交叉处用对应颜色的圆点标注，圆点下方不再画线。
  // 买入=橙，卖出=蓝（与买卖点标注、弹窗头部图例共用同一常量）。仅日K及以上周期标注。
  const buildMarkLine = (mkrs, dts, ohlcArr) => {
    if (!mkrs || !mkrs.length || !dts || !dts.length || !ohlcArr || !ohlcArr.length) return null
    let maxHigh = 0
    for (const c of ohlcArr) if (c[3] > maxHigh) maxHigh = c[3]
    const topY = maxHigh * 1.03
    const seen = new Set()
    const items = []
    for (const m of mkrs) {
      const key = (m.date || '') + '|' + (m.side || '')
      if (seen.has(key)) continue
      seen.add(key)
      let idx = -1
      for (let i = 0; i < dts.length; i++) {
        if (String(dts[i]).slice(0, 10) <= (m.date || '')) idx = i
        else break
      }
      if (idx < 0) idx = 0
      const isBuy = m.side === 'BUY'
      const color = isBuy ? KL_COLORS.buy : KL_COLORS.sell
      const candle = ohlcArr[idx]
      if (!candle) continue
      const crossY = candle[1] // 收盘价作为与 K 线交叉的锚点
      items.push([
        {
          coord: [dts[idx], topY],
          lineStyle: { color, type: 'dashed', width: 1.5 },
          itemStyle: { color },
          label: {
            show: true,
            formatter: isBuy ? '买入' : '卖出',
            position: 'start',
            color,
            fontSize: 11,
            fontWeight: 'bold',
          },
        },
        { coord: [dts[idx], crossY] },
      ])
    }
    return items
  }
  const markLineData = isKPeriod ? buildMarkLine(markers, dates, ohlc) : null
  // v32：默认视野 = 按周期对齐自然日期窗口（日K近6个月/周K近1年半/月K近5年/年K近10年，
  // 所有标的一致；历史不足窗口时显示全部）；分钟K不适用则维持原固定比例。
  const defaultZoom = buildDefaultZoom(period, dates) || { type: 'inside', xAxisIndex: [0, 1, 2], start: 40, end: 100 }

  // 图例选中状态变化：把「未选中」的双色图例图标换成灰版（image 图标不会自动置灰）
  const onLegendSelectChanged = useCallback((params) => {
    const chart = chartRef.current
    if (!chart) return
    const sel = (params && params.selected) || {}
    const unselected = new Set(Object.keys(sel).filter((k) => sel[k] === false))
    chart.setOption({ legend: { data: buildLegendData(unselected) } }, false)
  }, [])

  const option = {
    animation: false,
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    graphic: [
      { type: 'text', left: 8, top: 38, style: { text: pLabel + ' · MA', fill: '#8b949e', fontSize: 12, fontWeight: 'bold' } },
      { type: 'text', left: 8, top: '59%', style: { text: '成交量', fill: '#8b949e', fontSize: 12, fontWeight: 'bold' } },
      { type: 'text', left: 8, top: '79%', style: { text: 'MACD', fill: '#8b949e', fontSize: 12, fontWeight: 'bold' } },
    ],
    legend: {
      data: buildLegendData(NO_UNSELECTED),
      textStyle: { color: '#8b949e' }, top: 0, type: 'scroll', itemWidth: 14, itemHeight: 14,
    },
    grid: [
      { left: 64, right: 20, top: 30, height: '52%', containLabel: false },
      { left: 64, right: 20, top: '62%', height: '15%', containLabel: false },
      { left: 64, right: 20, top: '82%', height: '15%', containLabel: false },
    ],
    xAxis: [
      { type: 'category', gridIndex: 0, data: dates, axisLabel: { color: '#8b949e', formatter: xFmt }, axisLine: { lineStyle: { color: '#2a3040' } } },
      { type: 'category', gridIndex: 1, data: dates, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#2a3040' } } },
      { type: 'category', gridIndex: 2, data: dates, axisLabel: { color: '#8b949e', formatter: xFmt }, axisLine: { lineStyle: { color: '#2a3040' } } },
    ],
    yAxis: [
      { gridIndex: 0, scale: true, axisLabel: { color: '#8b949e' }, splitLine: { lineStyle: { color: 'rgba(42,48,64,.4)' } } },
      { gridIndex: 1, scale: true, axisLabel: { color: '#8b949e', formatter: (v) => (v >= 1e8 ? (v / 1e8).toFixed(1) + '亿' : v >= 1e4 ? (v / 1e4).toFixed(0) + '万' : v) }, splitLine: { lineStyle: { color: 'rgba(42,48,64,.4)' } } },
      { gridIndex: 2, scale: true, axisLabel: { color: '#8b949e' }, splitLine: { lineStyle: { color: 'rgba(42,48,64,.4)' } } },
    ],
    dataZoom: [defaultZoom],
    series: [
      {
        name: 'K线', type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0, data: ohlc,
        itemStyle: { color: KL_COLORS.up, color0: KL_COLORS.down,
                     borderColor: KL_COLORS.up, borderColor0: KL_COLORS.down },
        ...(markLineData ? { markLine: { symbol: ['none', 'circle'], symbolSize: 8, silent: true, data: markLineData } } : {}),
      },
      { name: 'MA5', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma5, symbol: 'none', lineStyle: { color: KL_COLORS.ma5, width: 1 } },
      { name: 'MA10', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma10, symbol: 'none', lineStyle: { color: KL_COLORS.ma10, width: 1 } },
      { name: 'MA20', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma20, symbol: 'none', lineStyle: { color: KL_COLORS.ma20, width: 1 } },
      {
        name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: volume,
        barWidth: '60%',
        itemStyle: { color: (p) => (ohlc[p.dataIndex][0] <= ohlc[p.dataIndex][1]
          ? KL_COLORS.volumeUp : KL_COLORS.volumeDown) },
      },
      { name: 'DIF', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: macdDIF, symbol: 'none', lineStyle: { color: KL_COLORS.dif, width: 1 } },
      { name: 'DEA', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: macdDEA, symbol: 'none', lineStyle: { color: KL_COLORS.dea, width: 1 } },
      {
        name: 'MACD', type: 'bar', xAxisIndex: 2, yAxisIndex: 2, data: macdBAR,
        barWidth: '50%',
        itemStyle: { color: (p) => (p.value >= 0 ? KL_COLORS.up : KL_COLORS.down) },
      },
    ],
  }

  return (
    <>
      {proxied && proxy_note && <div className="kline-proxy-note">⚠️ {proxy_note}</div>}
      {isMinute && (
        <div className="kline-proxy-note" style={{ color: '#8b949e' }}>
          ℹ️ 分钟K线真实数据源：腾讯行情（{pLabel}，近约 10 个交易日；仅A股提供）
        </div>
      )}
      <EChart
        option={option}
        className="chart-md"
        style={{ height: 660 }}
        onChartReady={(c) => { chartRef.current = c }}
        onEvents={{ legendselectchanged: onLegendSelectChanged }}
      />
    </>
  )
}

export default function KlineChart({ market, code, markers, preferMinute }) {
  // 分时真实数据源：A股/港股（含指数）当日实时；美股指数等休市时段显示"最近交易日"或本地跟踪；
  // GOLD（纽约金/沪金/伦敦金等期货指数）无外部逐分钟源，分时 = 本地记录（v32 需求5），故分时 tab 放行。
  // preferMinute=true（指数卡片打开）：无条件先请求分时，无当日源时自动落回日K并提示（GOLD 例外：等待本地记录出图）；
  // 否则仅 A/HK/BOND 默认分时，其余市场直接日K。
  const canMinute = market === 'A' || market === 'HK' || market === 'BOND' || market === 'GOLD'
  const canMinuteK = market === 'A'
  const [period, setPeriod] = useState(preferMinute || canMinute ? 'minute' : 'day')
  const [kdata, setKdata] = useState(null)   // 周期/分钟K数据
  const [intra, setIntra] = useState(null)   // 当日分时数据
  const [msg, setMsg] = useState('')         // 信息提示（数据源说明/自动落回原因）
  const [err, setErr] = useState('')         // 错误提示
  const [loading, setLoading] = useState(true)
  const userTouched = useRef(false)

  // 切换标的时回到默认周期
  useEffect(() => {
    userTouched.current = false
    setErr(''); setMsg(''); setKdata(null); setIntra(null); setLoading(true)
    setPeriod((preferMinute || canMinute) ? 'minute' : 'day')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, code, preferMinute])

  // 拉取数据（按当前周期）
  useEffect(() => {
    if (!market || !code) return
    let alive = true
    setLoading(true); setErr('')
    if (period === 'minute') {
      api.intraday(market, code)
        .then((d) => {
          if (!alive) return
          if (d && d.available && d.times && d.times.length >= 2) {
            setIntra(d); setLoading(false)
          } else {
            // 无真实分时数据：未手动操作时自动落回日K并说明；手动点击则给出原因
            if (!userTouched.current) {
              if (market === 'GOLD') {
                // v32 需求5：黄金指数分时=本地记录，无点即"记录中"——保持分时视图，由轮询自动出图
                setMsg((d && d.note) ? d.note : '分时数据源暂不可用（本地记录中，满 2 点自动显示）')
                setIntra(null); setKdata(null); setLoading(false)
              } else {
                setMsg((d && d.note) ? ('分时数据源暂不可用，已自动显示日K（' + d.note + '）') : '该标的分时数据暂不可用，已自动显示日K')
                setPeriod('day')
              }
            } else {
              setIntra(null); setKdata((k) => k || null)
              setErr((d && d.note) ? d.note : '该标的分时数据暂不可用')
              setLoading(false)
            }
          }
        })
        .catch((e) => {
          if (!alive) return
          if (!userTouched.current) {
            if (market === 'GOLD') {
              setMsg('分时数据暂不可用，正在重试（本地记录中）')
              setIntra(null); setKdata(null); setLoading(false)
            } else {
              setMsg('分时数据获取失败，已自动显示日K')
              setPeriod('day')
            }
          } else {
            setErr(e.message); setLoading(false)
          }
        })
    } else {
      const count = PERIOD_CNT[period] || 240
      api.kline(market, code, period, count)
        .then((k) => {
          if (!alive) return
          setKdata(k); setLoading(false)
          if (!msg) {
            if (period === 'year') setMsg('年K由真实月K数据聚合（数据源口径：前复权，个股自上市起）')
            else if (['week', 'month'].includes(period)) setMsg('')
          }
        })
        .catch((e) => {
          if (!alive) return
          setErr(e.message); setLoading(false)
        })
    }
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, code, period])

  // v32 需求5：黄金指数（GOLD）分时=本地记录。当前无分时数据时每 12s 轮询一次，
  // 一旦本地记录满 2 点（available）即自动切换显示当日分时曲线；手动切分时也生效。
  useEffect(() => {
    if (market !== 'GOLD' || !code || period !== 'minute' || intra || loading) return
    const timer = setInterval(() => {
      api.intraday(market, code)
        .then((d) => {
          if (d && d.available && d.times && d.times.length >= 2) {
            clearInterval(timer)
            setIntra(d); setLoading(false)
            if (d.note) setMsg(d.note)
          } else if (d && d.note) {
            setMsg(d.note)   // 记录中：实时刷新已采样点数等提示
          }
        })
        .catch(() => {})
    }, 12000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, code, period, intra, loading])

  const handleTab = (key) => {
    if (key === period) return
    userTouched.current = true
    setErr(''); setMsg(''); setKdata(null); setIntra(null)
    setPeriod(key)
  }

  const tabBtn = (t) => {
    const disabled = (t.key === 'minute' ? !canMinute : /^m\d+$/.test(t.key) ? !canMinuteK : false)
    const active = period === t.key
    return (
      <button
        key={t.key}
        disabled={disabled}
        onClick={() => handleTab(t.key)}
        style={{
          marginRight: 4, padding: '3px 10px', cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: 12, borderRadius: 4, border: active ? '1px solid #58a6ff' : '1px solid #30363d',
          background: active ? 'rgba(88,166,255,.15)' : 'transparent',
          color: disabled ? '#484f58' : (active ? '#58a6ff' : '#8b949e'),
          opacity: disabled ? .55 : 1,
        }}
        title={disabled ? (t.key === 'minute' ? '该市场无当日分时数据源' : '分钟K线仅A股提供真实数据源') : ''}
      >
        {t.label}
      </button>
    )
  }

  const showK = (period !== 'minute') && kdata
  const showIntra = (period === 'minute') && intra

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
        {PERIOD_TABS.map(tabBtn)}
        {loading && <span style={{ marginLeft: 10, color: '#8b949e', fontSize: 12 }}>加载中…</span>}
      </div>
      {msg && <div className="kline-proxy-note" style={{ color: '#8b949e' }}>ℹ️ {msg}</div>}
      {err && <div className="kline-proxy-note" style={{ color: '#f85149' }}>⚠️ {err}</div>}
      {showIntra && <IntradayView data={intra} />}
      {showK && <KlineView kdata={kdata} markers={markers} period={period} />}
      {!loading && period === 'minute' && market === 'GOLD' && !intra && (
        <div className="empty" style={{ padding: 40, textAlign: 'center', color: '#8b949e' }}>
          ⏳ 分时数据记录中…（本地记录：系统运行期间每分钟采样该品种真实实时价作为当日分时，
          满 2 分钟自动显示曲线；可先点上方「日K」查看历史）
        </div>
      )}
      {!loading && !showK && !showIntra && !(period === 'minute' && market === 'GOLD') && (
        <div className="empty" style={{ padding: 40, textAlign: 'center', color: '#8b949e' }}>
          📭 暂无数据
        </div>
      )}
    </div>
  )
}
