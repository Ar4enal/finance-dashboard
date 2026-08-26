import React, { useState, useEffect, useContext } from 'react'
import { api } from '../api.js'
import { RefreshContext } from '../refresh.js'

export default function News() {
  const [news, setNews] = useState([])
  const [keyword, setKeyword] = useState('')
  const refreshSec = useContext(RefreshContext)

  useEffect(() => {
    api.news().then(setNews).catch(() => {})
    const t = setInterval(() => { api.news().then(setNews).catch(() => {}) }, refreshSec * 1000)
    return () => clearInterval(t)
  }, [refreshSec])

  const reload = () => api.news(keyword).then(setNews).catch(() => {})

  const filtered = keyword ? news.filter(n => n.title && n.title.toLowerCase().includes(keyword.toLowerCase())) : news

  return (
    <section className="page active">
      <div className="page-head">
        <div>
          <div className="page-title">财经资讯</div>
          <div className="page-sub">影响金融市场的要闻</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className="refresh">自动刷新 {refreshSec}s</span>
          <button className="btn-ghost" onClick={reload} title="立即刷新">⟳ 刷新</button>
        </div>
      </div>
      <div className="search-row">
        <input className="search-input" placeholder="关键词筛选…" value={keyword} onChange={e => setKeyword(e.target.value)} />
        <button className="btn-ghost" onClick={reload}>⟳ 刷新</button>
      </div>
      <div className="card" id="newsList">
        {filtered.map((n, i) => (
          <div key={i} className="news-item">
            <div className="news-title"><a href={n.url || '#'} target="_blank" rel="noreferrer">{n.title}</a>{n.market || n.sector ? <span className="news-tag">{n.market || '国内'}·{n.sector || '综合'}</span> : null}</div>
            <div className="news-sum">{n.summary}</div>
            <div className="news-time">
              <span>{n.time}</span>
              {n.url ? (
                <a href={n.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>查看原文 →</a>
              ) : <span className="muted">无原文链接</span>}
            </div>
          </div>
        ))}
        {filtered.length === 0 && <div className="empty">无匹配资讯</div>}
      </div>
    </section>
  )
}
