import React, { useState, useEffect, useContext } from 'react'
import EChart from '../components/EChart.jsx'
import ProfitDisplay from '../components/ProfitDisplay.jsx'
import { api } from '../api.js'
import { RefreshContext } from '../refresh.js'

const fmt = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }))
const money = (n) => (n == null ? '—' : '¥' + fmt(n, 0))
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '')
const sign = (n) => (n == null ? '—' : (n > 0 ? '+' : '') + fmt(n))
// v21：场外基金净值显示 4 位小数，其他市场 2 位
const pfmt = (n, market) => (n == null ? '—' : fmt(n, market === 'FUND' ? 4 : 2))

export default function Dashboard() {
  const [summary, setSummary] = useState(null)
  const [positions, setPositions] = useState([])
  const refreshSec = useContext(RefreshContext)

  const load = () => {
    api.portfolioSummary().then(setSummary).catch(() => {})
    api.positions().then(setPositions).catch(() => {})
  }

  useEffect(() => {
    load()
    const t = setInterval(load, refreshSec * 1000)  // 按配置频率实时刷新（行情 + 资产）
    return () => clearInterval(t)
  }, [refreshSec])

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
        <div className="stat">
          <div className="label">当前持仓收益</div>
          <div className={`value ${cls(summary?.totalHoldingPnl)}`}>{sign(summary?.totalHoldingPnl)}</div>
          <div className={`sub ${cls(summary?.totalHoldingPnlPct)}`}>{sign(summary?.totalHoldingPnlPct)}%</div>
        </div>
        <div className="stat">
          <div className="label">累计收益</div>
          <div className={`value ${cls(summary?.totalCumPnl)}`}>{sign(summary?.totalCumPnl)}</div>
          <div className="sub" style={{ color: 'var(--muted)', fontSize: 11 }}>含已实现盈利</div>
        </div>
      </div>
      <div className="dash-grid">
        <div className="card">
          <div className="card-title">持仓盈亏分布</div>
          {positions.filter(p => p.data_available !== false).length === 0
            ? <div className="empty">暂无可用行情数据</div>
            : <EChart
            className="chart-md"
            option={{
              tooltip: { trigger: 'item', formatter: '{b}: {c}' },
              grid: { left: 60, right: 20, top: 20, bottom: 30 },
              xAxis: { type: 'category', data: positions.filter(p => p.data_available !== false).map(p => p.name || p.code), axisLabel: { color: '#8b949e' }, axisLine: { lineStyle: { color: '#2a3040' } } },
              yAxis: { type: 'value', axisLabel: { color: '#8b949e' }, splitLine: { lineStyle: { color: 'rgba(42,48,64,.4)' } } },
              series: [{
                type: 'bar', data: positions.filter(p => p.data_available !== false).map(p => p.pnl || 0),
                itemStyle: { color: (p) => p.value >= 0 ? '#f85149' : '#3fb950' },
                label: { show: true, position: 'top', color: '#8b949e', formatter: '{c}' },
              }],
            }}
          />}
        </div>
        <div className="card">
          <div className="card-title">持仓概览</div>
          {positions.length === 0 ? <div className="empty">暂无持仓，请先录入交易</div> : (
            <div>
              {positions.map(p => (
                <div key={p.code + p.market} className="pos-card" style={{ marginBottom: 10 }}>
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
    </section>
  )
}
