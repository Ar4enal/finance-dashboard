import React, { useState, useEffect } from 'react'
import { api } from '../api.js'

const fmt = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }))
const money = (n) => (n == null ? '—' : '¥' + fmt(n, 0))
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '')

export default function Reports() {
  const [positions, setPositions] = useState([])
  const [txns, setTxns] = useState([])

  const load = () => {
    Promise.all([api.positions(), api.transactions()])
      .then(([p, t]) => { setPositions(p); setTxns(t) })
      .catch(() => {})
  }

  useEffect(() => { load() }, [])

  const totalMv = positions.reduce((s, p) => s + (p.market_value || 0), 0)
  const totalCost = positions.reduce((s, p) => s + (p.cost || 0), 0)
  const totalPnl = totalMv - totalCost
  const totalPct = totalCost ? (totalPnl / totalCost * 100) : 0

  return (
    <section className="page active">
      <div className="page-head">
        <div>
          <div className="page-title">报表</div>
          <div className="page-sub">持仓汇总 · 交易流水</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-ghost" onClick={load} title="立即刷新">⟳ 刷新</button>
          <button className="btn-ghost" onClick={() => window.open('/api/reports/export?fmt=csv')}>导出 CSV</button>
          <button className="btn-ghost" onClick={() => window.print()}>打印</button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">持仓汇总</div>
        <table>
          <thead><tr><th>名称</th><th>市场</th><th className="num">数量</th><th className="num">市值</th><th className="num">成本</th><th className="num">盈亏</th><th className="num">收益率</th></tr></thead>
          <tbody>
            {positions.map(p => (
              <tr key={p.code}>
                <td>{p.name || p.code}</td>
                <td><span className="badge badge-a">{p.market}</span></td>
                <td className="num">{fmt(p.quantity, 0)}</td>
                <td className="num">{money(p.market_value)}</td>
                <td className="num">{money(p.cost)}</td>
                <td className={`num ${cls(p.pnl)}`}>{money(p.pnl)}</td>
                <td className={`num ${cls(p.pnl_pct)}`}>{fmt(p.pnl_pct)}%</td>
              </tr>
            ))}
            <tr style={{ fontWeight: 700 }}>
              <td>合计</td><td></td><td></td>
              <td className="num">{money(totalMv)}</td>
              <td className="num">{money(totalCost)}</td>
              <td className={`num ${cls(totalPnl)}`}>{money(totalPnl)}</td>
              <td className={`num ${cls(totalPct)}`}>{fmt(totalPct)}%</td>
            </tr>
          </tbody>
        </table>
        {positions.length === 0 && <div className="empty">暂无持仓</div>}
      </div>

      <div className="card">
        <div className="card-title">交易流水</div>
        <table>
          <thead><tr><th>日期</th><th>代码</th><th>市场</th><th>方向</th><th className="num">数量</th><th className="num">价格</th><th className="num">金额</th></tr></thead>
          <tbody>
            {txns.map(t => (
              <tr key={t.id}>
                <td>{t.trans_date}</td><td>{t.code}</td>
                <td><span className="badge badge-a">{t.market}</span></td>
                <td><span className={`badge ${t.side === 'BUY' ? 'badge-a' : 'badge-u'}`}>{t.side === 'BUY' ? '买入' : '卖出'}</span></td>
                <td className="num">{fmt(t.quantity)}</td>
                <td className="num">{fmt(t.price)}</td>
                <td className="num">{money(t.quantity * t.price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {txns.length === 0 && <div className="empty">暂无交易记录</div>}
      </div>
    </section>
  )
}
