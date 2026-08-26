import React, { useState, useEffect, useContext } from 'react'
import EChart from '../components/EChart.jsx'
import { api } from '../api.js'
import { RefreshContext } from '../refresh.js'
import { useKline } from '../kline.jsx'

const fmt = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }))
const money = (n) => (n == null ? '—' : '¥' + fmt(n, 0))
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '')
const sign = (n) => (n == null ? '—' : (n > 0 ? '+' : '') + fmt(n))

export default function Analysis() {
  const [summary, setSummary] = useState(null)
  const [alloc, setAlloc] = useState([])
  const [by, setBy] = useState('market')
  const [perf, setPerf] = useState(null)  // 净值曲线（每日快照）
  const [allocModal, setAllocModal] = useState(null)  // 饼图点击弹窗：对应分组的 allocation 项
  const refreshSec = useContext(RefreshContext)
  const { openKline } = useKline()

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
          <button className="btn-ghost" onClick={() => { loadSummary(); loadAlloc(); loadPerf() }} title="立即刷新">⟳ 刷新</button>
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
                {allocModal.items.map((it, i) => (
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
