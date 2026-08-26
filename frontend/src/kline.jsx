import React, { useState, useContext, useCallback } from 'react'
import KlineChart from './components/KlineChart.jsx'

// 全局 K 线弹窗：任意页面通过 useKline() 拿到 openKline(market, code, name)，
// 点击基金/股票/指数的名称或卡片即可查看 K 线行情（日K · MA · MACD）。
const KlineContext = React.createContext({ openKline: () => {} })

export function KlineProvider({ children }) {
  const [kline, setKline] = useState(null) // { market, code, name }

  const openKline = useCallback((market, code, name) => {
    if (!code) return
    setKline({ market: market || 'A', code, name: name || code })
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
            <KlineChart market={kline.market} code={kline.code} />
          </div>
        </div>
      )}
    </KlineContext.Provider>
  )
}

export function useKline() {
  return useContext(KlineContext)
}
