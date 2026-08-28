import React, { useState, useEffect, useContext } from 'react'
import EChart from '../components/EChart.jsx'
import ProfitDisplay from '../components/ProfitDisplay.jsx'
import { api } from '../api.js'
import { RefreshContext } from '../refresh.js'
import { useKline } from '../kline.jsx'

const fmt = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }))
const money = (n) => (n == null ? '—' : '¥' + fmt(n, 0))
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '')
const sign = (n) => (n == null ? '—' : (n > 0 ? '+' : '') + fmt(n))
// v21：场外基金净值显示 4 位小数，其他市场 2 位
const pfmt = (n, market) => (n == null ? '—' : fmt(n, market === 'FUND' ? 4 : 2))

// 总览卡片详情：近一个月每日收益折线图（v26）。最右当前日期，dataZoom 可向左滑动至第一条记录。
function buildPnlSeriesOption(d, kind) {
  const dates = d.dates || []
  const series = kind === 'holding' ? (d.cumulative_pnl || []) : (d.cumulative_pnl || [])
  const daily = d.daily_pnl || []
  return {
    animation: false,
    tooltip: { trigger: 'axis', formatter: p => {
      const i = p[0].dataIndex
      return `${dates[i]}<br/>当日收益 ${sign(daily[i])}<br/>累计 ${sign(series[i])}`
    } },
    grid: { left: 64, right: 20, top: 24, bottom: 56 },
    xAxis: { type: 'category', data: dates, axisLabel: { color: '#8b949e', rotate: dates.length > 15 ? 40 : 0 }, axisLine: { lineStyle: { color: '#2a3040' } } },
    yAxis: { type: 'value', scale: true, axisLabel: { color: '#8b949e', formatter: v => v >= 1e4 ? (v / 1e4).toFixed(1) + '万' : v }, splitLine: { lineStyle: { color: 'rgba(42,48,64,.4)' } } },
    dataZoom: [
      { type: 'inside', start: 0, end: 100 },
      { type: 'slider', start: 0, end: 100, height: 18, bottom: 18, borderColor: '#2a3040', textStyle: { color: '#8b949e' } },
    ],
    series: [{
      name: kind === 'holding' ? '当前持仓收益' : '累计收益',
      type: 'line', data: series, smooth: false, showSymbol: false,
      lineStyle: { color: '#58a6ff', width: 2 },
      areaStyle: { color: 'rgba(88,166,255,.10)' },
      markLine: { silent: true, symbol: 'none', lineStyle: { color: '#3a4150', type: 'dashed' }, data: [{ yAxis: 0 }] },
    }],
  }
}


export default function Dashboard() {
  const [summary, setSummary] = useState(null)
  const [positions, setPositions] = useState([])
  const [pnlOffset, setPnlOffset] = useState(0)  // 持仓盈亏分布：滑块窗口偏移（窗口大小 10）
  const [pnlDetail, setPnlDetail] = useState(null)  // 总览卡片详情弹窗 {kind, title, data}
  const refreshSec = useContext(RefreshContext)
  const { openKline } = useKline()

  const load = () => {
    api.portfolioSummary().then(setSummary).catch(() => {})
    api.positions().then(setPositions).catch(() => {})
  }

  // 总览卡片点击 → 查看近一个月收益折线图（v26）
  const openPnlDetail = (kind) => {
    const title = kind === 'holding' ? '当前持仓收益 · 近一个月走势' : '累计收益 · 近一个月走势'
    api.pnlSeries(30, kind).then(d => setPnlDetail({ kind, title, data: d })).catch(() => setPnlDetail(null))
  }

  useEffect(() => {
    load()
    const t = setInterval(load, refreshSec * 1000)  // 按配置频率实时刷新（行情 + 资产）
    return () => clearInterval(t)
  }, [refreshSec])

  // 持仓盈亏分布：按持仓收益（pnl）降序排列，窗口最多展示 10 个，滑块可向右查看更多
  const pnlAll = positions
    .filter(p => p.data_available !== false)
    .slice()
    .sort((a, b) => {
      const va = a.pnl == null ? -Infinity : a.pnl
      const vb = b.pnl == null ? -Infinity : b.pnl
      if (va !== vb) return vb - va  // 由左至右：收益高（赚）→ 收益低（亏）
      const ka = a.name || a.code || '', kb = b.name || b.code || ''
      return ka < kb ? -1 : ka > kb ? 1 : 0  // 同级用名称稳定排序
    })
  const pnlMaxScroll = Math.max(0, pnlAll.length - 10)
  const pnlSafe = Math.min(pnlOffset, pnlMaxScroll)
  const pnlView = pnlAll.slice(pnlSafe, pnlSafe + 10)

  return (
    <section className="page active">
      <div className="page-head">
        <div>
          <div className="page-title">总览</div>
          <div className="page-sub">资产组合 · 概览</div>
        </div>
        <button className="btn-ghost" onClick={load} title="立即刷新">⟳ 刷新</button>
      </div>
      {summary && summary.goldAvailable === false && (
        <div className="warn-bar">⚠️ 实时国内金价暂不可用，实物黄金按成本价计入资产，盈亏数据暂缺。</div>
      )}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <div className="stat"><div className="label">总资产</div><div className="value">{money(summary?.totalMarketValue)}</div></div>
        <div className="stat"><div className="label">总成本</div><div className="value">{money(summary?.totalCost)}</div></div>
        <div className="stat" style={{ cursor: 'pointer' }} title="点击查看近一个月收益走势" onClick={() => openPnlDetail('holding')}>
          <div className="label">当前持仓收益 <span style={{ color: 'var(--accent)' }}>📈</span></div>
          <div className={`value ${cls(summary?.totalHoldingPnl)}`}>{sign(summary?.totalHoldingPnl)}</div>
          <div className={`sub ${cls(summary?.totalHoldingPnlPct)}`}>{sign(summary?.totalHoldingPnlPct)}%</div>
        </div>
        <div className="stat" style={{ cursor: 'pointer' }} title="点击查看近一个月收益走势" onClick={() => openPnlDetail('cum')}>
          <div className="label">累计收益 <span style={{ color: 'var(--accent)' }}>📈</span></div>
          <div className={`value ${cls(summary?.totalCumPnl)}`}>{sign(summary?.totalCumPnl)}</div>
          <div className="sub" style={{ color: 'var(--muted)', fontSize: 11 }}>含已实现盈利</div>
        </div>
      </div>
      <div className="dash-grid">
        <div className="card">
          <div className="card-title">持仓盈亏分布</div>
          {pnlAll.length === 0
            ? <div className="empty">暂无可用行情数据</div>
            : <>
              <EChart
                className="chart-md"
                option={{
                  tooltip: { trigger: 'item', formatter: '{b}: {c}' },
                  grid: { left: 60, right: 20, top: 20, bottom: 30 },
                  xAxis: { type: 'category', data: pnlView.map(p => p.name || p.code), axisLabel: { color: '#8b949e' }, axisLine: { lineStyle: { color: '#2a3040' } } },
                  yAxis: { type: 'value', axisLabel: { color: '#8b949e' }, splitLine: { lineStyle: { color: 'rgba(42,48,64,.4)' } } },
                  series: [{
                    type: 'bar', data: pnlView.map(p => p.pnl || 0),
                    itemStyle: { color: (p) => p.value >= 0 ? '#f85149' : '#3fb950' },
                    label: { show: true, position: 'top', color: '#8b949e', formatter: '{c}' },
                  }],
                }}
              />
              {pnlMaxScroll > 0 && (
                <div className="chart-scroll">
                  <input type="range" min={0} max={pnlMaxScroll} step={1} value={pnlSafe}
                    onChange={(e) => setPnlOffset(Number(e.target.value))}
                    aria-label="持仓盈亏分布滑动条" />
                  <div className="chart-scroll-info">第 {pnlSafe + 1}–{pnlSafe + pnlView.length} 个 / 共 {pnlAll.length} 个持仓</div>
                </div>
              )}
            </>}
        </div>
        <div className="card">
          <div className="card-title">持仓概览</div>
          {positions.length === 0 ? <div className="empty">暂无持仓，请先录入交易</div> : (
            <div>
              {positions.slice().sort((a, b) => {
                // 持仓概览按市值由多到少排序；市值为 null（清仓/行情不可用）排最后
                const va = a.market_value == null ? -Infinity : a.market_value
                const vb = b.market_value == null ? -Infinity : b.market_value
                if (vb !== va) return vb - va
                // 次级稳定键：名称，保证顺序稳定
                const ka = (a.name || a.code || ''), kb = (b.name || b.code || '')
                return ka < kb ? -1 : ka > kb ? 1 : 0
              }).map(p => (
                <div key={p.code + p.market} className="pos-card clickable" style={{ marginBottom: 10, cursor: 'pointer' }}
                  title="点击查看 K 线行情" onClick={() => openKline(p.market, p.code, p.name)}>
                  <div className="top">
                    <span className="name">{p.name || p.code}</span>
                    <span className="code">{p.market}</span>
                    {p.sold_out && <span className="sold-out-badge" style={{ marginLeft: 6 }}>已清仓</span>}
                  </div>
                  {p.data_available === false
                    ? <div className="empty" style={{ margin: '8px 0' }}>实时行情数据暂不可用</div>
                    : p.sold_out ? (
                      <div className="empty" style={{ margin: '8px 0' }}>已清仓 · 累计收益 {sign(p.cumPnl)}</div>
                    ) : <ProfitDisplay
                        market={p.market} code={p.code}
                        holdingPnl={p.holdingPnl} cumPnl={p.cumPnl}
                        holdingPnlEdited={p.holdingPnlEdited} cumPnlEdited={p.cumPnlEdited}
                        size="md" onSaved={load}
                      />}
                  <div className="pos-row"><span>数量</span><b>{p.sold_out ? '—' : fmt(p.quantity, p.is_physical_gold ? 2 : 0)}</b></div>
                  <div className="pos-row"><span>现价 / 市值</span><b>{p.sold_out ? <span className="muted">— / —</span> : (p.data_available === false ? <span className="muted">— / —</span> : `${pfmt(p.price, p.market)} / ${money(p.market_value)}`)}</b></div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 总览卡片详情：近一个月收益折线图（v26） */}
      {pnlDetail && (
        <div className="alloc-modal-mask" onClick={() => setPnlDetail(null)}>
          <div className="modal-card" style={{ width: 'min(860px, 94vw)' }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <span>{pnlDetail.title}</span>
              <button className="modal-close" onClick={() => setPnlDetail(null)}>✕</button>
            </div>
            <div className="modal-body">
              {pnlDetail.data && pnlDetail.data.dates && pnlDetail.data.dates.length
                ? <>
                    <EChart className="chart-lg" option={buildPnlSeriesOption(pnlDetail.data, pnlDetail.kind)} />
                    <div className="pnl-series-foot">最右为当前日期（{pnlDetail.data.latest_date}）；拖动下方滑块或滚轮可向左滑动查看更早记录。</div>
                  </>
                : <div className="empty">暂无收益记录（组合分析页需积累至少 2 天快照）</div>}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
