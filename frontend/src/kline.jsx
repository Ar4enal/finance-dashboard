import React, { useState, useContext, useCallback } from 'react'
import KlineChart from './components/KlineChart.jsx'

// 全局 K 线弹窗：任意页面通过 useKline() 拿到 openKline(market, code, name, markers)，
// 点击基金/股票/指数的名称或卡片即可查看 K 线行情（日K · MA · MACD）。
// markers（可选）：用户录入的买卖时间点 [{ date: 'YYYY-MM-DD', side: 'BUY'|'SELL' }]，
// 在 K 线顶部用竖直虚线 + 文字标注买入（橙）/ 卖出（蓝）。持仓产品点开时由持仓页传入。
const KlineContext = React.createContext({ openKline: () => {} })

export function KlineProvider({ children }) {
  const [kline, setKline] = useState(null) // { market, code, name, markers }

  const openKline = useCallback((market, code, name, markers) => {
    if (!code) return
    setKline({ market: market || 'A', code, name: name || code, markers: markers || null })
  }, [])

  const close = useCallback(() => setKline(null), [])

  return (
    <KlineContext.Provider value={{ openKline }}>
      {children}
      {kline && (
        <div className="modal show" onClick={close}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: 920 }}>
            <div className="modal-head">
              <h3>{kline.name} ({kline.code}) · 日K · MA · MACD</h3>
              <button className="modal-close" onClick={close}>×</button>
            </div>
            {kline.markers && kline.markers.length > 0 && (
              <div style={{ padding: '0 16px 8px', fontSize: 12, color: 'var(--muted)' }}>
                <span style={{ color: '#ff8c00', fontWeight: 'bold' }}>┊ 橙色虚线 = 买入</span>
                <span style={{ margin: '0 10px', color: '#1e90ff', fontWeight: 'bold' }}>┊ 蓝色虚线 = 卖出</span>
                <span>（共 {kline.markers.length} 个买卖点）</span>
              </div>
            )}
            <KlineChart market={kline.market} code={kline.code} markers={kline.markers} />
          </div>
        </div>
      )}
    </KlineContext.Provider>
  )
}

export function useKline() {
  return useContext(KlineContext)
}
