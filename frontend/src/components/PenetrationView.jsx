import React from 'react'

const fmt = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }))
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '')
const sign = (n) => (n == null ? '—' : (n > 0 ? '+' : '') + fmt(n))

/**
 * 场内基金穿透详情。
 * props: pen 来自 /api/fund/penetrate 的 data
 */
export default function PenetrationView({ pen }) {
  if (!pen) return null
  if (pen.available === false) {
    return <div className="empty" style={{ padding: 12 }}>穿透数据不可用：{pen.unavailable || '无法获取持仓'}</div>
  }

  return (
    <div className="pen-block">
      {/* 穿透估值概览 */}
      <div className="pen-summary">
        <div className="fi">
          <div className="l">穿透估算涨跌</div>
          <div className={`v ${cls(pen.est_pct)}`}>{sign(pen.est_pct)}%</div>
        </div>
        <div className="fi">
          <div className="l">估算净值</div>
          <div className="v">{pen.est_nav != null ? fmt(pen.est_nav, 4) : '—'}</div>
        </div>
        <div className="fi">
          <div className="l">重仓覆盖率</div>
          <div className="v">{fmt(pen.coverage)}%</div>
        </div>
        <div className="fi">
          <div className="l">持仓披露</div>
          <div className="v" style={{ fontSize: 13 }}>{pen.report || '—'}</div>
        </div>
        {pen.inmarket && (
          <>
            <div className="fi">
              <div className="l">场内现价</div>
              <div className={`v ${cls(pen.market_pct)}`}>{pen.market_price != null ? fmt(pen.market_price, 3) : '—'}</div>
            </div>
            <div className="fi">
              <div className="l">场内涨跌</div>
              <div className={`v ${cls(pen.market_pct)}`}>{sign(pen.market_pct)}%</div>
            </div>
            <div className="fi">
              <div className="l">折溢价</div>
              <div className={`v ${cls(pen.premium)}`}>{pen.premium != null ? sign(pen.premium) + '%' : '—'}</div>
            </div>
          </>
        )}
      </div>

      {pen.calib_mode === 'calibrated' && (
        <div className="tip-line" style={{ fontSize: 12, color: 'var(--accent)', margin: '6px 0', background: 'rgba(58,126,232,.08)', padding: '8px 10px', borderRadius: 6 }}>
          🔧 重仓覆盖率低（{fmt(pen.coverage)}%），已用<b>基金历史近20日平均涨跌</b>校准未覆盖持仓（避免把未覆盖部分按 0 涨跌计算），估算较纯重仓加权更稳健，仍仅供参考。
        </div>
      )}
      {pen.calib_mode === 'direct' && pen.coverage < 50 && (
        <div className="warn-bar" style={{ fontSize: 12 }}>
          ⚠️ 重仓覆盖率仅 {fmt(pen.coverage)}%，穿透估算偏差较大，仅供参考。
        </div>
      )}
      {pen.calib_mode === 'no_coverage' && (
        <div className="warn-bar" style={{ fontSize: 12 }}>
          ⚠️ 前十大重仓覆盖率过低或行情不可用，无法可靠穿透估算，仅供参考。
        </div>
      )}
      {(pen.calib_mode === 'direct' && pen.coverage >= 50) && (
        <div className="tip-line" style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0' }}>
          穿透估算基于季报披露的前十大重仓股实时涨跌加权，非基金公司实时数据。
        </div>
      )}

      {/* 重仓股逐行贡献 */}
      <div className="card-title" style={{ marginTop: 8 }}>前十大重仓 · 实时行情与贡献</div>
      <table>
        <thead><tr><th>股票</th><th className="num">占净值</th><th className="num">最新价</th><th className="num">涨跌幅</th><th className="num">对基金贡献</th></tr></thead>
        <tbody>
          {pen.stocks.map(s => (
            <tr key={s.code}>
              <td>{s.name} <span className="muted" style={{ fontSize: 11 }}>{s.code}</span></td>
              <td className="num">{fmt(s.pct)}%</td>
              <td className="num" style={{ fontWeight: 600 }}>{s.available ? fmt(s.price) : <span className="muted">不可用</span>}</td>
              <td className={`num ${cls(s.pctchg)}`}>{s.available ? sign(s.pctchg) + '%' : '—'}</td>
              <td className={`num ${cls(s.contrib)}`}>{sign(s.contrib)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
