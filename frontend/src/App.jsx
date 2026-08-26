import React, { useState, useEffect, useCallback } from 'react'
import { api } from './api.js'
import { RefreshContext, REFRESH_OPTIONS, loadRefreshSec, saveRefreshSec } from './refresh.js'
import { KlineProvider } from './kline.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Quotes from './pages/Quotes.jsx'
import Positions from './pages/Positions.jsx'
import Analysis from './pages/Analysis.jsx'
import Reports from './pages/Reports.jsx'
import News from './pages/News.jsx'

const NAV = [
  { key: 'dashboard', label: '总览', ico: '📊' },
  { key: 'quotes', label: '行情看板', ico: '📈' },
  { key: 'positions', label: '持仓管理', ico: '💼' },
  { key: 'analysis', label: '组合分析', ico: '📉' },
  { key: 'reports', label: '报表', ico: '🗒️' },
  { key: 'news', label: '财经资讯', ico: '📰' },
]

const GITHUB_URL = 'https://github.com/Ar4enal/finance-dashboard'

export default function App() {
  const [page, setPage] = useState('dashboard')
  const [refreshSec, setRefreshSec] = useState(loadRefreshSec)

  const onRefreshChange = (e) => {
    const v = Number(e.target.value)
    setRefreshSec(v)
    saveRefreshSec(v)
  }

  return (
    <RefreshContext.Provider value={refreshSec}>
      <KlineProvider>
        <div className="app">
          <aside className="sidebar">
            <div className="logo"><span className="dot" />金融工作台</div>
            <nav className="nav">
              {NAV.map(n => (
                <div
                  key={n.key}
                  className={`nav-item ${page === n.key ? 'active' : ''}`}
                  onClick={() => setPage(n.key)}
                >
                  <span className="ico">{n.ico}</span>{n.label}
                </div>
              ))}
            </nav>
            <div className="sidebar-refresh">
              <span className="sr-label">自动刷新</span>
              <select className="sr-select" value={refreshSec} onChange={onRefreshChange} title="设置数据自动刷新频率">
                {REFRESH_OPTIONS.map(o => <option key={o} value={o}>{o}s</option>)}
              </select>
            </div>
            <div className="sidebar-foot"><span className="dot" />本地运行 · 金融工作台</div>
          </aside>
          <main className="main">
            {page === 'dashboard' && <Dashboard />}
            {page === 'quotes' && <Quotes />}
            {page === 'positions' && <Positions />}
            {page === 'analysis' && <Analysis />}
            {page === 'reports' && <Reports />}
            {page === 'news' && <News />}
            <footer className="app-footer">
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">📌 开源地址：{GITHUB_URL}</a>
              <div className="src-line">
                数据来源：<b>新浪财经</b>行情 · <b>腾讯</b>行情 · <b>天天基金</b> · <b>东方财富</b>板块资金流 · <b>新浪财经</b>资讯（实时数据，获取失败均提示「数据暂不可用」，绝不填充虚拟数据）
              </div>
            </footer>
          </main>
        </div>
      </KlineProvider>
    </RefreshContext.Provider>
  )
}
