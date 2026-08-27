import React, { useState, useEffect, useContext } from 'react'
import EChart from '../components/EChart.jsx'
import { api } from '../api.js'
import { RefreshContext } from '../refresh.js'
import { useKline } from '../kline.jsx'

const fmt = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }))
const money = (n) => (n == null ? '—' : '¥' + fmt(n, 0))
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '')
const sign = (n) => (n == null ? '—' : (n > 0 ? '+' : '') + fmt(n))

// 收益分析 - 柱状图：每个持仓在区间内收益
function buildBarOption(pnl) {
  const data = (pnl.details || [])
  const names = data.map(d => d.name || d.code)
  const vals = data.map(d => d.pnl)
  const maxAbs = Math.max(1, ...vals.map(v => Math.abs(v || 0)))
  return {
    animation: false,
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: p => {
      const it = p[0]; return `${names[it.dataIndex]}<br/>区间收益 ${sign(it.value)}`
    } },
    grid: { left: 70, right: 20, top: 20, bottom: 50 },
    xAxis: { type: 'category', data: names, axisLabel: { color: '#8b949e', interval: 0, rotate: names.length > 6 ? 30 : 0 }, axisLine: { lineStyle: { color: '#2a3040' } } },
    yAxis: { type: 'value', axisLabel: { color: '#8b949e', formatter: v => v >= 1e4 ? (v / 1e4).toFixed(1) + '万' : v }, splitLine: { lineStyle: { color: 'rgba(42,48,64,.4)' } } },
    series: [{
      type: 'bar', data: vals.map(v => ({ value: v, itemStyle: { color: (v || 0) >= 0 ? '#f85149' : '#3fb950' } })),
      barMaxWidth: 46,
    }],
  }
}

// 收益分析 - 日历图：每日组合收益热力日历
function buildCalendarOption(pnl) {
  const cal = pnl.calendar || []
  const data = cal.map(c => [c.date, c.pnl])
  // 日历范围：day/month 用 range 的月/月；year 用年；cum 用首年
  let range = pnl.range
  if (pnl.type === 'day') range = (pnl.range || '').slice(0, 7)
  else if (pnl.type === 'year') range = (pnl.range || '').slice(0, 4)
  else if (pnl.type === 'cum') range = (pnl.start_date || pnl.range || '').slice(0, 4)
  const vals = cal.map(c => c.pnl || 0)
  const maxAbs = Math.max(1, ...vals.map(v => Math.abs(v)))
  return {
    animation: false,
    tooltip: { formatter: p => `${p.data[0]}<br/>收益 ${sign(p.data[1])}` },
    visualMap: {
      min: -maxAbs, max: maxAbs, calculable: true, orient: 'horizontal', left: 'center', bottom: 0,
      inRange: { color: ['#3fb950', '#2d333b', '#f85149'] },
      textStyle: { color: '#8b949e' },
    },
    calendar: { top: 36, left: 30, right: 30, cellSize: ['auto', 22], range,
      itemStyle: { borderColor: '#161b22', borderWidth: 1 },
      splitLine: { lineStyle: { color: '#2a3040' } },
      yearLabel: { color: '#8b949e' }, monthLabel: { color: '#8b949e' }, dayLabel: { color: '#8b949e' } },
    series: [{ type: 'heatmap', coordinateSystem: 'calendar', data }],
  }
}

export default function Analysis() {
  const [summary, setSummary] = useState(null)
  const [alloc, setAlloc] = useState([])
  const [by, setBy] = useState('market')
  const [perf, setPerf] = useState(null)  // 净值曲线（每日快照）
  const [allocModal, setAllocModal] = useState(null)  // 饼图点击弹窗：对应分组的 allocation 项
  // 收益分析模块
  const [pnlType, setPnlType] = useState('day')       // day|month|year|cum
  const [pnlRange, setPnlRange] = useState(new Date().toISOString().slice(0, 10))  // 默认今天
  const [pnlChart, setPnlChart] = useState('calendar') // calendar|bar（默认日历图）
  const [pnl, setPnl] = useState(null)
  const refreshSec = useContext(RefreshContext)
  const { openKline } = useKline()

  // 收益分析：类型/范围变化时加载；同时跟随行情刷新（refreshSec）实时更新
  const loadPnl = () => {
    const range = pnlType === 'day' ? pnlRange
      : pnlType === 'month' ? pnlRange.slice(0, 7)
      : pnlType === 'year' ? pnlRange.slice(0, 4)
      : ''
    api.pnlAnalysis(pnlType, range).then(setPnl).catch(() => setPnl(null))
  }
  useEffect(() => { loadPnl() }, [pnlType, pnlRange, refreshSec])

  // 点击饼图元素 → 弹出该分组下的持仓明细
  const onPieClick = (params) => {
    const group = alloc.find(a => a.name === params.name)
    if (group && group.items && group.items.length) setAllocModal(group)
  }

  const loadSummary = () => api.portfolioSummary().then(setSummary).catch(() => {})
  const loadAlloc = () => api.portfolioAllocation(by).then(setAlloc).catch(() => {})
  const loadPerf = () => api.portfolioPerformance().then(setPerf).catch(() => {})

  useEffect(() => {
    loadSummary()
    loadPerf()
    const t = setInterval(() => { loadSummary(); loadPerf() }, refreshSec * 1000)  // 按配置频率实时刷新
    return () => clearInterval(t)
  }, [refreshSec])

  useEffect(() => {
    loadAlloc()
    const t = setInterval(loadAlloc, refreshSec * 1000)
    return () => clearInterval(t)
  }, [by, refreshSec])

  return (
    <section className="page active">
      <div className="page-head">
        <div>
          <div className="page-title">组合分析</div>
          <div className="page-sub">资产分配 · 绩效指标</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div className="seg" style={{ display: 'flex', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <button style={{ padding: '7px 14px', border: 'none', background: by === 'market' ? 'rgba(88,166,255,.15)' : 'transparent', color: by === 'market' ? '#58a6ff' : '#8b949e', cursor: 'pointer', fontWeight: by === 'market' ? 600 : 400 }} onClick={() => setBy('market')}>按市场</button>
            <button style={{ padding: '7px 14px', border: 'none', background: by === 'code' ? 'rgba(88,166,255,.15)' : 'transparent', color: by === 'code' ? '#58a6ff' : '#8b949e', cursor: 'pointer', fontWeight: by === 'code' ? 600 : 400 }} onClick={() => setBy('code')}>按标的</button>
          </div>
          <button className="btn-ghost" onClick={() => { loadSummary(); loadAlloc(); loadPerf(); loadPnl() }} title="立即刷新">⟳ 刷新</button>
        </div>
      </div>

      <div className="dash-grid2">
        <div className="card">
          <div className="card-title">资产分配<span className="pc-sub" style={{ marginLeft: 8, fontSize: 12 }}>点击饼图扇区查看该类型持仓明细</span></div>
          <EChart className="chart-md" onEvents={{ click: onPieClick }} option={{
            tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
            legend: { textStyle: { color: '#8b949e' }, bottom: 0 },
            series: [{
              type: 'pie', radius: ['40%', '66%'], center: ['50%', '44%'],
              itemStyle: { borderColor: '#161b22', borderWidth: 2 },
              label: { color: '#8b949e', formatter: '{b} {d}%' },
              data: alloc.map((a, i) => ({ name: a.name, value: a.value, itemStyle: { color: ['#58a6ff', '#d29922', '#f85149', '#3fb950', '#a371f7'][i % 5] } })),
            }],
          }} />
          {alloc.length === 0 && <div className="empty">暂无持仓数据</div>}
        </div>
        <div className="card">
          <div className="card-title">绩效指标</div>
          <div className="metric">
            <div className="m"><div className="l">总市值</div><div className="v">{money(summary?.totalMarketValue)}</div></div>
            <div className="m"><div className="l">总成本</div><div className="v">{money(summary?.totalCost)}</div></div>
            <div className="m"><div className="l">当前持仓收益</div><div className={`v ${cls(summary?.totalHoldingPnl)}`}>{sign(summary?.totalHoldingPnl)}</div><div className="l">{sign(summary?.totalHoldingPnlPct)}%</div></div>
            <div className="m"><div className="l">累计收益（含已实现）</div><div className={`v ${cls(summary?.totalCumPnl)}`}>{sign(summary?.totalCumPnl)}</div></div>
          </div>
        </div>
      </div>

      {/* 净值曲线（每日快照，随使用天数自然积累） */}
      <div className="card">
        <div className="card-title">净值曲线（每日快照）
          <span className="pc-sub" style={{ marginLeft: 8, fontSize: 12 }}>组合页每天首次打开时自动记录当日快照，数据随使用天数积累</span>
        </div>
        {perf && perf.dates.length > 0 ? (
          <>
            <EChart className="chart-md" option={{
              animation: false,
              tooltip: { trigger: 'axis' },
              legend: { data: ['总市值', '总成本'], textStyle: { color: '#8b949e' }, top: 0 },
              grid: { left: 70, right: 20, top: 34, bottom: 30 },
              xAxis: { type: 'category', data: perf.dates, axisLabel: { color: '#8b949e' }, axisLine: { lineStyle: { color: '#2a3040' } } },
              yAxis: { type: 'value', scale: true, axisLabel: { color: '#8b949e', formatter: v => v >= 1e4 ? (v / 1e4).toFixed(1) + '万' : v }, splitLine: { lineStyle: { color: 'rgba(42,48,64,.4)' } } },
              dataZoom: [{ type: 'inside', start: 0, end: 100 }],
              series: [
                { name: '总市值', type: 'line', data: perf.equity, symbol: 'none', lineStyle: { color: '#58a6ff', width: 2 }, areaStyle: { color: 'rgba(88,166,255,.12)' } },
                { name: '总成本', type: 'line', data: perf.cost, symbol: 'none', lineStyle: { color: '#8b949e', width: 1, type: 'dashed' } },
              ],
            }} />
            <div className="metric" style={{ marginTop: 12 }}>
              <div className="m"><div className="l">最大回撤</div><div className={`v ${cls(perf.maxDrawdown)}`}>{sign(perf.maxDrawdown)}%</div></div>
              <div className="m"><div className="l">累计收益率</div><div className={`v ${cls(perf.totalReturn)}`}>{sign(perf.totalReturn)}%</div></div>
              <div className="m"><div className="l">快照天数</div><div className="v">{perf.count}</div></div>
              <div className="m"><div className="l">最新总市值</div><div className="v">{money(perf.equity[perf.equity.length - 1])}</div></div>
            </div>
          </>
        ) : (
          <div className="empty">暂无净值快照。组合分析页每天首次打开时自动记录当日快照，数据积累后这里将展示净值曲线与最大回撤。</div>
        )}
      </div>

      {/* 收益分析模块：日/月/年/累计收益 + 每持仓明细 + 柱状/日历图 */}
      <div className="card">
        <div className="card-title">收益分析
          <span className="pc-sub" style={{ marginLeft: 8, fontSize: 12 }}>组合与每个持仓的真实收益（基于每日净值快照，随使用天数积累）</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 }}>
          {/* 收益类型：日/月/年/累计 */}
          <div className="seg" style={{ display: 'flex', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            {[['day', '日收益'], ['month', '月收益'], ['year', '年收益'], ['cum', '累计收益']].map(([k, lbl]) => (
              <button key={k} style={{ padding: '7px 14px', border: 'none', background: pnlType === k ? 'rgba(88,166,255,.15)' : 'transparent', color: pnlType === k ? '#58a6ff' : '#8b949e', cursor: 'pointer', fontWeight: pnlType === k ? 600 : 400 }}
                onClick={() => setPnlType(k)}>{lbl}</button>
            ))}
          </div>
          {/* 范围选择 */}
          <input className="form-input" type={pnlType === 'day' ? 'date' : pnlType === 'month' ? 'month' : 'text'}
            placeholder={pnlType === 'year' ? '年份如 2026' : ''}
            value={pnlRange}
            onChange={e => setPnlRange(e.target.value)}
            style={{ width: pnlType === 'year' ? 120 : 160 }} />
          {/* 图表类型：日历/柱状（默认日历） */}
          <div className="seg" style={{ display: 'flex', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <button style={{ padding: '7px 14px', border: 'none', background: pnlChart === 'calendar' ? 'rgba(88,166,255,.15)' : 'transparent', color: pnlChart === 'calendar' ? '#58a6ff' : '#8b949e', cursor: 'pointer', fontWeight: pnlChart === 'calendar' ? 600 : 400 }}
              onClick={() => setPnlChart('calendar')}>日历图</button>
            <button style={{ padding: '7px 14px', border: 'none', background: pnlChart === 'bar' ? 'rgba(88,166,255,.15)' : 'transparent', color: pnlChart === 'bar' ? '#58a6ff' : '#8b949e', cursor: 'pointer', fontWeight: pnlChart === 'bar' ? 600 : 400 }}
              onClick={() => setPnlChart('bar')}>柱状图</button>
          </div>
        </div>

        {pnl && !pnl.available ? (
          <div className="empty">{pnl.note || '暂无收益数据'}</div>
        ) : pnl ? (
          <>
            <div className="metric" style={{ marginBottom: 12 }}>
              <div className="m"><div className="l">区间</div><div className="v" style={{ fontSize: 14 }}>{pnl.range}</div></div>
              <div className="m"><div className="l">{pnlType === 'day' ? '当日' : pnlType === 'month' ? '本月' : pnlType === 'year' ? '本年' : '累计'}收益</div><div className={`v ${cls(pnl.combo_pnl)}`}>{sign(pnl.combo_pnl)}</div><div className="l">{sign(pnl.combo_pnl_pct)}%</div></div>
              <div className="m"><div className="l">持仓数</div><div className="v">{pnl.details.length}</div></div>
            </div>
            {/* 图表：日历 / 柱状 */}
            {pnlChart === 'calendar' ? (
              <EChart className="chart-md" option={buildCalendarOption(pnl)} />
            ) : (
              <EChart className="chart-md" option={buildBarOption(pnl)} />
            )}
            {/* 收益明细：每个持仓在区间内的收益 */}
            <div className="card-title" style={{ marginTop: 14, fontSize: 14 }}>收益明细（每个持仓在区间内收益）</div>
            <table className="pnl-detail">
              <thead><tr><th>市场</th><th>代码</th><th>名称</th><th className="num">区间收益</th></tr></thead>
              <tbody>
                {pnl.details.length === 0 && <tr><td colSpan={4} className="am-empty">该区间无持仓收益明细（可能持仓快照不足或区间内无交易）</td></tr>}
                {pnl.details.map((d, i) => (
                  <tr key={i} style={{ cursor: 'pointer' }} onClick={() => openKline(d.market, d.code, d.name)} title="点击查看 K 线行情">
                    <td>{d.market}</td><td>{d.code}</td><td>{d.name}</td>
                    <td className={`num ${cls(d.pnl)}`}>{sign(d.pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <div className="empty">加载中…</div>
        )}
      </div>

      {/* 持仓分布饼图点击弹窗：展示该分组下的持仓明细 */}
      {allocModal && (
        <div className="alloc-modal-mask" onClick={() => setAllocModal(null)}>
          <div className="alloc-modal" onClick={e => e.stopPropagation()}>
            <div className="am-head">
              <div className="am-title">{allocModal.name} · 持仓明细</div>
              <button className="am-close" onClick={() => setAllocModal(null)} title="关闭">×</button>
            </div>
            <table>
              <thead><tr><th>产品代码</th><th>产品名称</th><th className="num">市值</th><th className="num">占该类型</th></tr></thead>
              <tbody>
                {/* 明细按持仓市值降序排序展示（不修改原数据） */}
                {[...allocModal.items].sort((a, b) => (b.market_value || 0) - (a.market_value || 0)).map((it, i) => (
                  <tr key={i} style={{ cursor: 'pointer' }} onClick={() => openKline(it.market, it.code, it.name)}
                    title="点击查看 K 线行情">
                    <td>{it.code}</td>
                    <td>{it.name}</td>
                    <td className="num">{money(it.market_value)}</td>
                    <td className="num">{it.pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(!allocModal.items || allocModal.items.length === 0) && <div className="am-empty">暂无明细</div>}
          </div>
        </div>
      )}
    </section>
  )
}
