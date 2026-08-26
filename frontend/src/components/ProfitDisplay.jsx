import React, { useState } from 'react'
import { api } from '../api.js'

const fmt = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }))
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '')

/**
 * 收益展示 + 编辑组件。
 * props:
 *  - market, code: 资产标识（实物黄金 code=GOLD_PHYSICAL）
 *  - holdingPnl, cumPnl: 当前持仓收益、累计收益
 *  - holdingPnlEdited, cumPnlEdited: 是否被用户编辑覆盖
 *  - size: 'sm' | 'md'（显示紧凑度）
 *  - onSaved: 保存成功后回调（用于刷新看板）
 */
export default function ProfitDisplay({ market, code, holdingPnl, cumPnl, holdingPnlEdited, cumPnlEdited, size = 'md', onSaved }) {
  const [editing, setEditing] = useState(null)  // 'holding' | 'cum' | null
  const [val, setVal] = useState('')

  const openEdit = (which, cur) => {
    setEditing(which)
    setVal(cur == null ? '' : String(cur))
  }

  const save = async () => {
    const v = parseFloat(val)
    if (isNaN(v)) { alert('请输入有效数字'); return }
    try {
      const holding = editing === 'holding' ? v : undefined
      const cum = editing === 'cum' ? v : undefined
      await api.saveProfit(market, code, holding, cum)
      setEditing(null)
      if (onSaved) onSaved()
    } catch (e) { alert(e.message) }
  }

  const clearEdit = async (which) => {
    try {
      await api.clearProfit(market, code, which)
      setEditing(null)
      if (onSaved) onSaved()
    } catch (e) { alert(e.message) }
  }

  const small = size === 'sm'

  const renderField = (which, label, value, edited) => (
    <div className="profit-field">
      <div className="profit-label">
        {label}
        <button className="profit-edit-btn" title="编辑" onClick={() => openEdit(which, value)}>✎</button>
        {edited && <span className="profit-edited" title="已手动编辑，点击清除">手动</span>}
      </div>
      {editing === which ? (
        <div className="profit-edit-box">
          <input className="form-input" style={{ width: small ? 80 : 110 }} type="number" step="0.01"
            value={val} onChange={e => setVal(e.target.value)} autoFocus
            onKeyDown={e => { if (e.key === 'Enter') save() }} />
          <button className="btn btn-sm" onClick={save}>✓</button>
          <button className="btn-danger btn-sm" title="恢复自动计算" onClick={() => clearEdit(which)}>↺</button>
          <button className="btn-ghost btn-sm" onClick={() => setEditing(null)}>×</button>
        </div>
      ) : (
        <div className={`profit-value ${cls(value)}`} style={{ fontSize: small ? 12 : 14 }}>
          {value == null ? '—' : '¥' + fmt(value)}
        </div>
      )}
    </div>
  )

  return (
    <div className="profit-display" style={small ? { gap: 10 } : {}}>
      {renderField('holding', '当前持仓收益', holdingPnl, holdingPnlEdited)}
      {renderField('cum', '累计收益', cumPnl, cumPnlEdited)}
    </div>
  )
}
