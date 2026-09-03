import React, { useState, useEffect, useCallback, useContext } from 'react'
import { api } from '../api.js'
import KlineChart from '../components/KlineChart.jsx'
import PenetrationView from '../components/PenetrationView.jsx'
import { RefreshContext } from '../refresh.js'
import { useKline } from '../kline.jsx'
import { useInputHistory, clearHistory, loadHistory } from '../history.js'

// 带历史记忆的输入框
function HistInput({ field, type = 'text', value, onChange, placeholder, className = 'form-input', style, ...rest }) {
  const h = useInputHistory(field, value, onChange)
  return (
    <div className="hist-wrap" ref={h.wrapRef}>
      <input
        type={type}
        className={className}
        style={style}
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onFocus={() => h.list.length && h.setOpen(true)}
        onBlur={h.onBlur}
        {...rest}
      />
      {h.open && h.list.length > 0 && (
        <div className="hist-list">
          {h.list.map((v, i) => (
            <div key={i} className="hist-item" onMouseDown={() => h.commit(v)}>
              <span>{v}</span>
              <span className="hi-del" onMouseDown={(e) => { e.stopPropagation(); clearHistory(field, v); h.setList(loadHistory(field)); }}>✕</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const fmt = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }))
const money = (n) => (n == null ? '—' : '¥' + fmt(n, 0))
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '')
const sign = (n) => (n == null ? '—' : (n > 0 ? '+' : '') + fmt(n))

// v31：指数卡片迷你分时小图（SVG polyline，涨红跌绿按最新价 vs 昨收）
// 数据来自 /api/kline/intraday/batch（腾讯当日实时 / 东财最近交易日 / 本地跟踪文件）
function IndexSpark({ spark }) {
  const UP = '#f85149'
  const DOWN = '#3fb950'
  const MUTED = '#8b949e'
  const { available, price, prev_close, trade_date, source, note } = spark || {}
  const n = (price || []).length
  const w = 100, h = 30, pad = 2
  if (!available || !n) {
    const tip = (note || '分时数据暂不可用') + (trade_date ? '（数据日期 ' + trade_date + '）' : '')
    return (
      <div className="idx-spark" title={tip} style={{ marginTop: 6, height: h, display: 'flex', alignItems: 'center', fontSize: 10, color: MUTED }}>
        <span style={{ border: '1px dashed rgba(139,148,158,.5)', borderRadius: 4, padding: '1px 8px', opacity: .8 }}>分时·暂无（每交易日自动记录）</span>
      </div>
    )
  }
  const pc = (prev_close != null && prev_close > 0) ? prev_close : price[0]
  const last = price[n - 1]
  const color = last >= pc ? UP : DOWN
  const min = Math.min(...price)
  const max = Math.max(...price)
  const span = (max - min) || Math.abs(max) * 0.001 || 1
  const pts = price.map((v, i) => {
    const x = n === 1 ? w / 2 : (i / (n - 1)) * w
    const y = pad + (1 - (v - min) / span) * (h - pad * 2)
    return x.toFixed(2) + ',' + y.toFixed(2)
  }).join(' ')
  const dateTip = (trade_date ? '数据日期 ' + trade_date + '；' : '') +
    (source === 'tencent' ? '当日实时（腾讯）' : source === 'eastmoney' ? '最近交易日（东方财富）' : source === 'local' ? '本地跟踪记录（每分钟采样）' : '行情源')
  return (
    <div className="idx-spark" title={'分时小图：' + dateTip} style={{ marginTop: 6, opacity: .95 }}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: h, display: 'block' }}>
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}

// v23：自选基金/标的按日涨跌幅排序（可调升/降），行情不可用（pct 缺失）的沉底（按 -Infinity 处理）
const sortByPct = (arr, dir = 'desc') => (arr || []).slice().sort((a, b) => {
  const pa = a && a.pct != null ? Number(a.pct) : Number.NEGATIVE_INFINITY
  const pb = b && b.pct != null ? Number(b.pct) : Number.NEGATIVE_INFINITY
  return dir === 'asc' ? pa - pb : pb - pa
})

// v26：预估日收益 = 日涨跌幅 × 当前持仓市值；基金 code 在持仓中带 fu_ 前缀，按 key 归一化匹配
const normCode = (market, code) => (market === 'FUND' ? String(code).replace(/^fu_/, '') : String(code))
const rowKey = (market, code) => `${market}:${normCode(market, code)}`

// v23：行情看板暂不展示单独的「场内基金穿透」模块（保留代码，恢复时置 true）
const SHOW_PENETRATION = false

// 指数配置已改为后端持久化（custom_indices 表，首次启动自动填充内置预置）：
//   国内：上证指数/深证成指/创业板指/科创50/沪深300
//   国外：纳斯达克/标普500/道琼斯/费城半导体
// 用户在行情看板可自行新增/删除指数。

// 默认预置基金（仅当自选基金为空时填充）
const DEFAULT_FUNDS = [
  { code: '161725', name: '招商中证白酒' },
  { code: '005827', name: '易方达蓝筹精选' },
  { code: '161726', name: '招商国证生物医药' },
]

export default function Quotes() {
  const refreshSec = useContext(RefreshContext)
  const [indexQuotes, setIndexQuotes] = useState({})
  const [indexCollapsed, setIndexCollapsed] = useState(true)
  const [funds, setFunds] = useState([])
  const [fundDetail, setFundDetail] = useState(null)
  const [fundPen, setFundPen] = useState(null)  // 详情弹窗的穿透数据
  const [penLoading, setPenLoading] = useState(false)
  const [penetrations, setPenetrations] = useState([])  // 持仓基金穿透概览
  const [watchlist, setWatchlist] = useState([])
  const [fundSort, setFundSort] = useState({ key: 'pct', dir: 'desc' }) // 自选基金排序：key=pct(日涨跌幅)/pnl(预估日收益)，dir=asc/desc
  const [watchSort, setWatchSort] = useState({ key: 'pct', dir: 'desc' }) // 自选标的排序
  const { openKline } = useKline()
  const [search, setSearch] = useState('')
  const [gold, setGold] = useState(null)
  const [mvMap, setMvMap] = useState({}) // (market:code) -> 持仓市值，用于预估日收益
  // 异动跟踪阈值（1%~10%，默认5%），localStorage 持久化（v26）
  const [anomalyPct, setAnomalyPct] = useState(() => {
    try { const v = parseFloat(localStorage.getItem('fw_anomaly_pct')); return (v >= 1 && v <= 10) ? v : 5 } catch { return 5 }
  })
  const setAnomaly = (v) => { setAnomalyPct(v); try { localStorage.setItem('fw_anomaly_pct', String(v)) } catch {} }
  // 点击表头切换排序：同列则翻转方向，异列则按该列降序
  const toggleSort = (set, cur, key) => set(cur.key === key ? { key, dir: cur.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' })
  // 指数配置（用户可自定义选择/新增/删除，后端持久化）
  const [indices, setIndices] = useState([])
  const [showAddIndex, setShowAddIndex] = useState(false)
  const [idxForm, setIdxForm] = useState({ name: '', market: 'A', code: '' })
  // A股板块资金流向（当天前十流入/流出）
  const [sector, setSector] = useState(null)
  // v31：指数卡片迷你分时小图数据（key = `market:code`）
  const [sparkMap, setSparkMap] = useState({})

  const fetchIndex = useCallback(async () => {
    let list = []
    try { list = await api.indices() } catch {}
    setIndices(list)
    const items = list.map(i => `${i.market}:${i.code}`)
    if (!items.length) { setIndexQuotes({}); return }
    try {
      const data = await api.batchQuotes(items.join(','))
      const map = {}
      data.forEach(q => { map[q.code] = q })
      setIndexQuotes(map)
    } catch {}
  }, [])

  // v31：拉取指数卡片迷你分时（轻量批量；后端 30s 缓存，60s 轮询足够）
  const fetchSpark = useCallback(async () => {
    if (!indices.length) { setSparkMap({}); return }
    try {
      const data = await api.intradayBatch(indices.map(i => `${i.market}:${i.code}`).join(','))
      setSparkMap(data || {})
    } catch {}
  }, [indices])

  const fetchSector = useCallback(async () => {
    try { setSector(await api.sectorFlow()) } catch {}
  }, [])

  const fetchWatchlist = useCallback(async () => {
    try {
      let data = await api.watchlist()
      // 仅在「首次」初始化时预置默认基金（localStorage 标记），
      // 用户之后即使全部删除，也不会再自动出现默认基金。
      const INIT_KEY = 'fund_default_inited'
      if (!localStorage.getItem(INIT_KEY)) {
        const hasAnyFund = data.some(w => w.market === 'FUND')
        if (!hasAnyFund) {
          for (const f of DEFAULT_FUNDS) {
            try { await api.addWatch('FUND', f.code, f.name) } catch {}
          }
        }
        localStorage.setItem(INIT_KEY, '1')
        data = await api.watchlist()
      }
      // 合并「持仓管理」中的已持仓基金（自选基金同步于持仓）
      let heldFunds = []
      const mv = {}
      try {
        const pos = await api.positions()
        heldFunds = (pos || [])
          .filter(p => p.market === 'FUND' && p.code)
          .map(p => ({ market: 'FUND', code: String(p.code), name: p.name || p.code, held: true }))
        // 构建 (market:code) -> 持仓市值 映射，用于预估日收益（基金 code 归一化去 fu_ 前缀）
        ;(pos || []).forEach(p => {
          if (p.market_value != null) mv[rowKey(p.market, p.code)] = p.market_value
        })
      } catch {}
      setMvMap(mv)
      // 合并 watchlist FUND + 持仓基金（按 code 去重）
      const watchFunds = (data || []).filter(w => w.market === 'FUND')
      const fundByCode = {}
      watchFunds.forEach(w => { fundByCode[w.code] = { ...w, held: false, isWatch: true } })
      heldFunds.forEach(h => {
        if (fundByCode[h.code]) { fundByCode[h.code].held = true }
        else fundByCode[h.code] = { ...h, isWatch: false, id: null }
      })
      const mergedFunds = Object.values(fundByCode)
      const otherWatch = (data || []).filter(w => w.market !== 'FUND')

      // 统一拉行情
      const all = [...mergedFunds, ...otherWatch]
      if (all.length) {
        const items = all.map(w => `${w.market}:${w.code}`)
        const qs = await api.batchQuotes(items.join(','))
        const enrichedFunds = mergedFunds.map(w => {
          const q = qs.find(x => x.code === w.code)
          return { ...w, ...(q || {}), id: w.id }
        })
        const enrichedWatch = otherWatch.map(w => {
          const q = qs.find(x => x.code === w.code)
          return { ...w, ...(q || {}) }
        })
        // 存未排序的 enrichment 数据，排序在渲染时按 fundDir/watchDir 方向进行（点击表头即时切换，无需重新请求）
        setFunds(enrichedFunds)
        setWatchlist(enrichedWatch)
      } else {
        setFunds([])
        setWatchlist([])
      }
    } catch {}
  }, [])

  const fetchGold = useCallback(async () => {
    try { setGold(await api.gold()) } catch {}
  }, [])

  const fetchPenetrations = useCallback(async () => {
    try {
      const data = await api.fundPenetrationHoldings()
      setPenetrations(data || [])
    } catch {}
  }, [])

  useEffect(() => {
    fetchIndex()
    fetchWatchlist()
    fetchGold()
    fetchPenetrations()
    fetchSector()
    // 按配置频率刷新
    const t = setInterval(() => { fetchIndex(); fetchWatchlist(); fetchGold(); fetchPenetrations(); fetchSector() }, refreshSec * 1000)
    return () => clearInterval(t)
  }, [refreshSec, fetchIndex, fetchWatchlist, fetchGold, fetchPenetrations, fetchSector])

  // v31：指数卡片迷你分时：indices 变化立即拉一次，之后每 60s 轮询
  useEffect(() => {
    fetchSpark()
    const t = setInterval(fetchSpark, 60000)
    return () => clearInterval(t)
  }, [fetchSpark, indices])

  const openFund = async (code) => {
    try {
      setFundPen(null)
      setFundDetail(null)
      setPenLoading(true)
      const [d, pen] = await Promise.all([api.fundDetail(code), api.fundPenetrate(code)])
      setFundDetail(d)
      setFundPen(pen)
      setPenLoading(false)
    } catch { setPenLoading(false) }
  }

  // 智能识别代码类型：6位数字可能是基金或A股，需进一步判断
  const guessMarket = (code) => {
    const upper = code.toUpperCase()
    // 纯6位数字
    if (/^\d{6}$/.test(upper)) {
      // 场内基金常见前缀：15/16(LOF/ETF) 50/51/52/56/58(ETF/LOF) 159(深ETF) → 基金
      if (/^(15|16|50|51|52|56|58|159)/.test(upper)) return 'FUND'
      // 0 开头 → 场外基金（如 005827 易方达蓝筹），或深市主板股票（如 000001 平安银行）。
      // 由于代码冲突无法完美区分，0 开头优先按场外基金处理（场外基金更常见）。
      if (/^0/.test(upper)) return 'FUND'
      // 6 开头 → 沪市股票
      if (/^6/.test(upper)) return 'A'
      // 3 开头 → 深市创业板/中小板股票
      if (/^3/.test(upper)) return 'A'
      // 其他数字默认基金
      return 'FUND'
    }
    // 带交易所前缀：sh600519 / sz000001 / hk00700
    if (/^sh\d{6}$/i.test(upper)) return 'A'
    if (/^sz\d{6}$/i.test(upper)) return 'A'
    if (/^hk\d{5}$/i.test(upper)) return 'HK'
    // 美股代码（字母，非6位数字）
    if (/^[a-zA-Z]{1,5}$/.test(upper)) return 'US'
    // 其他默认 A 股
    return 'A'
  }

  const addWatch = async () => {
    const raw = search.trim()
    if (!raw) { alert('请输入代码'); return }
    const code = raw.toUpperCase()
    const market = guessMarket(code)
    // 若是美股个股，转小写（新浪 gb_ 需要小写）；A股带前缀则原样
    const finalCode = market === 'US' ? code.toLowerCase() : (market === 'A' && /^sh|^sz/i.test(code) ? code.toLowerCase() : code)
    try {
      const r = await api.addWatch(market, finalCode)
      setSearch('')
      await fetchWatchlist()
      alert(`已添加自选：${finalCode}（${market === 'US' ? '美股' : market === 'HK' ? '港股' : market === 'FUND' ? '基金' : 'A股'}）`)
    } catch (e) { alert(e.message) }
  }

  const removeFund = async (id) => {
    if (!window.confirm('确定从自选基金中删除吗？')) return
    await api.delWatch(id)
    fetchWatchlist()
  }

  const removeWatch = async (id) => {
    await api.delWatch(id)
    fetchWatchlist()
  }

  // 删除指数（自定义配置）
  const delIndex = async (idx) => {
    if (!window.confirm(`确定从行情看板删除指数「${idx.name}」（${idx.code}）吗？`)) return
    try {
      await api.delIndex(idx.id)
      fetchIndex()
    } catch (e) { alert(e.message) }
  }

  // 新增指数（自定义配置）
  const addIndex = async () => {
    const code = idxForm.code.trim()
    if (!code) { alert('请输入指数代码'); return }
    try {
      // v21：传原始 trim 后的 name（可空串），由后端在 name 为空时自动从行情拉取名称；
      // 之前用 `idxForm.name.trim() || code` 兜底导致后端永远收不到空串，自动识别失效。
      await api.addIndex(idxForm.name.trim(), idxForm.market, code)
      setShowAddIndex(false)
      setIdxForm({ name: '', market: 'A', code: '' })
      fetchIndex()
    } catch (e) { alert(e.message) }
  }

  // v23：期货指数快捷添加（纽约金 / 沪金 / 伦敦金）
  const addFuturesIndex = async (name, code) => {
    try {
      await api.addIndex(name, 'GOLD', code)
      fetchIndex()
    } catch (e) { alert(e.message) }
  }

  // v21：移动指数位置（与相邻行交换 sort_order，顶部 ▲ / 底部 ▼ 自动 disable）
  const moveIdx = async (idx, dir) => {
    try {
      const r = await api.moveIndex(idx.id, dir)
      if (r && r.moved) fetchIndex()
    } catch (e) { alert(e.message) }
  }
  // 顶部/底部判定（首/末位置禁用对应方向）
  const isFirst = (idx) => indices.length > 0 && indices[0].id === idx.id
  const isLast = (idx) => indices.length > 0 && indices[indices.length - 1].id === idx.id

  // 金额格式化（亿/万）
  const fmtMoney = (n) => {
    if (n == null) return '—'
    const abs = Math.abs(n)
    if (abs >= 1e8) return (n / 1e8).toFixed(2) + '亿'
    if (abs >= 1e4) return (n / 1e4).toFixed(1) + '万'
    return fmt(n, 0)
  }

  // 排序取值：pct=日涨跌幅，pnl=预估日收益（日涨跌幅 × 持仓市值）；缺失者沉底
  const valOf = (it, key) => {
    if (!it) return null
    if (key === 'pct') return it.pct != null ? Number(it.pct) : null
    if (key === 'pnl') {
      if (it.pct == null) return null
      const mvv = mvMap[rowKey(it.market, it.code)]
      return mvv != null ? (it.pct / 100) * mvv : null
    }
    return null
  }
  const sortRows = (arr, sort) => (arr || []).slice().sort((a, b) => {
    const va = valOf(a, sort.key), vb = valOf(b, sort.key)
    if (va === vb) return 0
    if (va === null || va === undefined) return 1  // 缺失沉底
    if (vb === null || vb === undefined) return -1
    return sort.dir === 'asc' ? va - vb : vb - va
  })
  // 渲染时按当前排序键/方向排序（点击表头即时切换，无需重新请求）
  const sortedFunds = sortRows(funds, fundSort)
  const sortedWatch = sortRows(watchlist, watchSort)
  // 异动判定：当日涨幅 > 阈值 或 跌幅 < -阈值
  const isAnomaly = (it) => it && it.pct != null && (it.pct > anomalyPct || it.pct < -anomalyPct)
  const anomalies = [...funds, ...watchlist].filter(isAnomaly)

  // v31：当日收益总和 = 本模块内「有持仓」产品的预估日收益合计（预估日收益 = 日涨跌幅 × 持仓市值）
  // 自选基金模块（含自动同步的持仓基金）与 自选标的模块 各自计算并展示在异动阈值左侧
  const pnlSumOf = (rows) => (rows || []).reduce((acc, it) => {
    const v = valOf(it, 'pnl')
    return v == null ? acc : acc + v
  }, 0)
  const fundPnlSum = pnlSumOf(funds)
  const watchPnlSum = pnlSumOf(watchlist)
  // 收益总和展示块（正收益红 up、负收益绿 down；无任何持仓收益时置灰）
  const pnlBadge = (label, sum) => {
    const has = sum != null && Math.abs(sum) > 1e-9
    const clsSum = has ? (sum > 0 ? 'up' : 'down') : ''
    return (
      <span className="pnl-sum" title="当日收益总和 = Σ（本模块中持仓产品 预估日收益），预估日收益 = 日涨跌幅 × 持仓市值"
        style={{ marginRight: 14, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
        {label}
        <span className={clsSum} style={{ fontVariantNumeric: 'tabular-nums' }}>{has ? '¥' + sign(sum) : '¥0.00'}</span>
      </span>
    )
  }

  return (
    <section className="page active">
      <div className="page-head">
        <div>
          <div className="page-title">行情看板</div>
          <div className="page-sub">指数 · 自选基金 · 自选标的</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className="refresh">自动刷新 {refreshSec}s</span>
          <button className="btn-ghost" onClick={() => { fetchIndex(); fetchWatchlist(); fetchGold(); fetchPenetrations(); fetchSector() }} title="立即刷新">⟳ 刷新</button>
        </div>
      </div>

      {/* 实时国内金价（实物黄金估值参考） */}
      <div className="gold-bar">
        <span className="gold-dot" />国内金价（人民币/克）
        <b style={{ marginLeft: 10, fontSize: 16 }}>
          {gold ? (gold.price_available ? '¥' + fmt(gold.price) + ' /克' : '数据暂不可用') : '加载中…'}
        </b>
        {gold && gold.price_available && gold.price_name && (
          <span style={{ color: 'var(--muted)', marginLeft: 6, fontSize: 12 }}>{gold.price_name}</span>
        )}
        {gold && gold.price_available && (
          <span style={{ color: cls(gold.price_pct), marginLeft: 10 }}>{sign(gold.price_pct)}%</span>
        )}
        {gold && gold.price_available && gold.price_asof && (
          <span style={{ color: 'var(--muted)', marginLeft: 10, fontSize: 12 }} title="国内金价来源：沪金 Au99.99（上海黄金交易所现货），取不到时回退沪金连续（上期所黄金期货）。非交易时段显示最近成交价">
            更新 {gold.price_asof}
          </span>
        )}
        {gold && gold.grams > 0 && (
          <span style={{ color: 'var(--muted)', marginLeft: 14, fontSize: 13 }}>
            实物黄金 {fmt(gold.grams, 2)} 克 · 市值 {gold.market_value != null ? money(gold.market_value) : '—'} · 盈亏 {gold.pnl != null ? sign(gold.pnl) : '—'}
          </span>
        )}
      </div>

      {/* v26：异动提醒横幅（涨跌幅超阈值时标亮并提醒） */}
      {anomalies.length > 0 && (
        <div className="anomaly-banner">
          <b>⚠️ 异动提醒</b>（阈值 {anomalyPct}%）：
          {anomalies.map(a => (
            <span key={a.market + a.code} className="anomaly-chip">{a.name || a.code} {sign(a.pct)}%</span>
          ))}
          触发涨跌幅异动，已在下方标亮。
        </div>
      )}

      {/* 指数大字卡（用户可自定义新增/删除，后端持久化） */}
      <div className="index-block">
        <div className="index-head">
          <span className="index-title">📌 指数</span>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>可自定义增删 · 点击卡片看K线</span>
          <span style={{ flex: 1 }} />
          <button className="btn-ghost btn-sm" onClick={() => setShowAddIndex(true)} title="新增自定义指数">＋ 新增指数</button>
          <button className="btn-ghost btn-sm" onClick={() => setIndexCollapsed(!indexCollapsed)}>
            {indexCollapsed ? '展开 ▼' : '收起 ▲'}
          </button>
        </div>
        <div className="index-cards">
          {indices.map(idx => {
            const q = indexQuotes[idx.code]
            const unavailable = q && q.available === false
            const first = isFirst(idx)
            const last = isLast(idx)
            return (
              <div key={idx.code + idx.market} className="index-card" onClick={() => openKline(idx.market, idx.code, idx.name, undefined, { preferMinute: true })}>
                <div className="ic-name">
                  <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, marginRight: 6 }}>
                    <span className={'idx-mv' + (first ? ' disabled' : '')} title={first ? '已是最顶部' : '上移'} onClick={(e) => { e.stopPropagation(); if (!first) moveIdx(idx, 'up') }}>▲</span>
                    <span className={'idx-mv' + (last ? ' disabled' : '')} title={last ? '已是最底部' : '下移'} onClick={(e) => { e.stopPropagation(); if (!last) moveIdx(idx, 'down') }}>▼</span>
                  </span>
                  {idx.name}
                  <span className="idx-del" title="删除该指数" onClick={(e) => { e.stopPropagation(); delIndex(idx) }}>✕</span>
                </div>
                {unavailable
                  ? <div className="ic-unavail">数据暂不可用</div>
                  : <>
                      <div className={`ic-value ${cls(q?.chg)}`}>{fmt(q?.price)}</div>
                      <div className={`ic-pct ${cls(q?.chg)}`}>{sign(q?.chg)} ({sign(q?.pct)}%)</div>
                      <IndexSpark spark={sparkMap[`${idx.market}:${idx.code}`] || sparkMap[`${idx.market}:${idx.code.toLowerCase()}`]} />
                    </>}
                <div className="ic-mark">{idx.code} · 点击看K线</div>
              </div>
            )
          })}
        </div>
        {indices.length === 0 && <div className="empty" style={{ marginTop: 8 }}>暂无指数，点击「＋ 新增指数」添加</div>}
      </div>

      {/* A股板块资金流向（当天前十流入/流出，真实数据） */}
      <div className="fund-block">
        <div className="index-head">
          <span className="index-title">💰 A股板块资金流向</span>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            {sector && sector.available && sector.asof
              ? <>更新于 {sector.asof} · 行业板块 · 主力净流入</>
              : '行业板块 · 主力净流入'}
          </span>
        </div>
        {sector && sector.available ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <div className="card-title" style={{ fontSize: 13, color: 'var(--up, #f85149)' }}>🔺 流入 TOP10</div>
              <table>
                <thead><tr><th>板块</th><th className="num">涨跌幅</th><th className="num">主力净流入</th><th className="num">占成交比</th></tr></thead>
                <tbody>
                  {sector.inflow.map(s => (
                    <tr key={s.code}>
                      <td>{s.name}</td>
                      <td className={`num ${cls(s.pct)}`}>{s.pct != null ? sign(s.pct) + '%' : '—'}</td>
                      <td className={`num ${s.main_net > 0 ? 'up' : 'down'}`}>{fmtMoney(s.main_net)}</td>
                      <td className="num">{s.main_pct != null ? sign(s.main_pct) + '%' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <div className="card-title" style={{ fontSize: 13, color: 'var(--down, #3fb950)' }}>🔻 流出 TOP10</div>
              <table>
                <thead><tr><th>板块</th><th className="num">涨跌幅</th><th className="num">主力净流入</th><th className="num">占成交比</th></tr></thead>
                <tbody>
                  {sector.outflow.map(s => (
                    <tr key={s.code}>
                      <td>{s.name}</td>
                      <td className={`num ${cls(s.pct)}`}>{s.pct != null ? sign(s.pct) + '%' : '—'}</td>
                      <td className={`num ${s.main_net > 0 ? 'up' : 'down'}`}>{fmtMoney(s.main_net)}</td>
                      <td className="num">{s.main_pct != null ? sign(s.main_pct) + '%' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="empty">板块资金流数据暂不可用（数据源未响应时显示，绝不填充虚拟数据）</div>
        )}
      </div>

      {/* v23：场内基金穿透模块暂不展示（保留代码，后续恢复将 SHOW_PENETRATION 置 true） */}
      {SHOW_PENETRATION && (
      <div className="fund-block">
        <div className="index-head">
          <span className="index-title">🔍 场内基金穿透</span>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>持仓基金 · 重仓股实时加权估算 · 点击看详情</span>
        </div>
        {penetrations.length === 0
          ? <div className="empty">暂无持仓基金。请先在「持仓管理」录入基金交易，即可查看穿透估值。</div>
          : penetrations.map(pen => (
              <div key={pen.code} className="pen-card" onClick={() => openFund(pen.code)}>
                <div style={{ flex: 1 }}>
                  <div className="pc-name">{pen.name || pen.code} <span className="pc-code">{pen.code}</span></div>
                  <div className="pc-sub">覆盖率 {pen.coverage != null ? fmt(pen.coverage) + '%' : '—'} · 披露 {pen.report || '—'}</div>
                </div>
                {pen.available === false ? (
                  <div className="pc-sub">穿透数据不可用</div>
                ) : (
                  <>
                    <div style={{ textAlign: 'right' }}>
                      <div className={`pc-num ${cls(pen.est_pct)}`}>{sign(pen.est_pct)}%</div>
                      <div className="pc-sub">估算涨跌</div>
                    </div>
                    {pen.inmarket && (
                      <div style={{ textAlign: 'right' }}>
                        <div className={`pc-num ${cls(pen.premium)}`}>{pen.premium != null ? sign(pen.premium) + '%' : '—'}</div>
                        <div className="pc-sub">折溢价</div>
                      </div>
                    )}
                    <span className="badge badge-blue">详情 ›</span>
                  </>
                )}
              </div>
            ))}
      </div>
      )}

      {/* 自选基金 */}
      <div className="fund-block">
        <div className="index-head">
          <span className="index-title">💼 自选基金</span>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>点击查看详情</span>
          <span style={{ flex: 1 }} />
          {pnlBadge('基金当日收益', fundPnlSum)}
          <span className="anomaly-set">
            异动阈值
            <select className="anomaly-sel" value={anomalyPct} onChange={e => setAnomaly(Number(e.target.value))} title="涨跌幅异动跟踪阈值（1%~10%，同时作用于自选标的）">
              {[1,2,3,4,5,6,7,8,9,10].map(n => <option key={n} value={n}>{n}%</option>)}
            </select>
          </span>
        </div>
        <table className="fund-table">
          <thead><tr>
            <th>名称</th><th>产品代码</th><th className="num">最新净值</th>
            <th className="num sortable" onClick={() => toggleSort(setFundSort, fundSort, 'pct')} title="点击切换升序 / 降序">日涨跌幅 <span className="sort-arr">{fundSort.key === 'pct' ? (fundSort.dir === 'asc' ? '↑' : '↓') : ''}</span></th>
            <th className="num sortable" onClick={() => toggleSort(setFundSort, fundSort, 'pnl')} title="点击切换升序 / 降序">预估日收益 <span className="sort-arr">{fundSort.key === 'pnl' ? (fundSort.dir === 'asc' ? '↑' : '↓') : ''}</span></th>
            <th>操作</th>
          </tr></thead>
          <tbody>
            {sortedFunds.map(f => {
              const est = valOf(f, 'pnl')
              const anom = isAnomaly(f)
              return (
              <tr key={f.code} className={anom ? 'anomaly' : ''} style={f.available === false ? { cursor: 'default' } : {}}>
                <td className="f-name fund-name-link" onClick={() => f.available !== false && openFund(f.code)}>
                  {f.name || f.code}
                  {f.held && <span className="badge badge-gold" style={{ marginLeft: 6 }}>持仓</span>}
                  {anom && <span className="anomaly-tag" title="涨跌幅触发异动阈值">异动</span>}
                </td>
                <td className="fund-code" onClick={() => f.available !== false && openFund(f.code)}>{f.code}</td>
                {f.available === false
                  ? <td className="num muted" colSpan={3}>数据暂不可用</td>
                  : <>
                      <td className="num" style={{ fontWeight: 600 }}>{fmt(f.price, 4)}</td>
                      <td className={`num ${cls(f.pct)}`}>{sign(f.pct)}%</td>
                      <td className={`num ${cls(est)}`}>{est == null ? '—' : '¥' + sign(est)}</td>
                    </>}
                <td className="op-col">
                  {f.available !== false && <span className="badge badge-blue" onClick={() => openFund(f.code)}>查看详情 ›</span>}
                  {f.held ? <span className="pc-sub" title="持仓基金来自持仓管理">持仓中</span>
                    : <button className="btn-danger" onClick={() => removeFund(f.id)}>删除</button>}
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
        {funds.length === 0 && <div className="empty">暂无自选基金，在下方输入 6 位基金代码添加</div>}
      </div>

      {/* 自选标的 */}
      <div className="search-row" style={{ marginTop: 16 }}>
        <input className="search-input" placeholder="输入代码：6位数字=基金，如 161725；或股票，如 sh600519/aapl" value={search} onChange={e => setSearch(e.target.value)} />
        <button className="btn" onClick={addWatch}>＋ 加自选</button>
        <button className="btn-ghost" onClick={() => { fetchIndex(); fetchWatchlist() }}>⟳ 刷新</button>
      </div>
      <div className="card">
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          自选标的
          <span style={{ flex: 1 }} />
          {pnlBadge('标的当日收益', watchPnlSum)}
          <span className="anomaly-set" style={{ fontSize: 12, fontWeight: 400 }}>
            异动阈值
            <select className="anomaly-sel" value={anomalyPct} onChange={e => setAnomaly(Number(e.target.value))} title="涨跌幅异动跟踪阈值（1%~10%，同时作用于自选基金）">
              {[1,2,3,4,5,6,7,8,9,10].map(n => <option key={n} value={n}>{n}%</option>)}
            </select>
          </span>
        </div>
        <table>
          <thead><tr>
            <th>名称</th><th>市场</th><th className="num">最新价</th><th className="num">涨跌额</th>
            <th className="num sortable" onClick={() => toggleSort(setWatchSort, watchSort, 'pct')} title="点击切换升序 / 降序">涨跌幅 <span className="sort-arr">{watchSort.key === 'pct' ? (watchSort.dir === 'asc' ? '↑' : '↓') : ''}</span></th>
            <th className="num sortable" onClick={() => toggleSort(setWatchSort, watchSort, 'pnl')} title="点击切换升序 / 降序">预估日收益 <span className="sort-arr">{watchSort.key === 'pnl' ? (watchSort.dir === 'asc' ? '↑' : '↓') : ''}</span></th>
            <th>操作</th>
          </tr></thead>
          <tbody>
            {sortedWatch.map(q => {
              const est = valOf(q, 'pnl')
              const anom = isAnomaly(q)
              return (
              <tr key={q.id} className={anom ? 'anomaly' : ''}>
                <td>{q.name || q.code}{anom && <span className="anomaly-tag" title="涨跌幅触发异动阈值">异动</span>}</td>
                <td><span className="badge badge-a">{q.market}</span></td>
                <td className="num" style={{ fontWeight: 600 }}>{q.available === false ? <span className="muted">数据暂不可用</span> : fmt(q.price)}</td>
                <td className={`num ${cls(q.chg)}`}>{q.available === false ? <span className="muted">—</span> : sign(q.chg)}</td>
                <td className={`num ${cls(q.pct)}`}>{q.available === false ? <span className="muted">—</span> : sign(q.pct) + '%'}</td>
                <td className={`num ${cls(est)}`}>{est == null ? '—' : '¥' + sign(est)}</td>
                <td>
                  <button className="btn btn-sm" onClick={() => q.available !== false && openKline(q.market, q.code, q.name)}>K线</button>
                  <button className="btn-danger" onClick={() => removeWatch(q.id)}>删除</button>
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
        {watchlist.length === 0 && <div className="empty">暂无自选标的，输入代码添加</div>}
      </div>

      {/* 新增指数模态 */}
      {showAddIndex && (
        <div className="modal show" onClick={() => setShowAddIndex(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>＋ 新增指数</h3>
              <button className="modal-close" onClick={() => setShowAddIndex(false)}>×</button>
            </div>
            <div className="pc-sub" style={{ marginBottom: 10, fontSize: 12, color: 'var(--muted)' }}>
              输入指数代码与名称（名称可留空自动识别）。A股指数如 <code>sh000001</code>（上证）、<code>sz399006</code>（创业板）、<code>sh000300</code>（沪深300）；国外指数如 <code>ixic</code>（纳斯达克）、<code>inx</code>（标普500）、<code>dji</code>（道琼斯）、<code>sox</code>（费城半导体）；期货指数（纽约金/沪金/伦敦金）可直接点下方快捷按钮添加。
            </div>
            <div className="form-row">
              <div><div className="form-label">市场</div>
                <select className="form-input" value={idxForm.market} onChange={e => setIdxForm({ ...idxForm, market: e.target.value })}>
                  <option value="A">A股</option><option value="US">美股</option><option value="GOLD">期货指数</option>
                </select></div>
              <div><div className="form-label">指数代码</div><HistInput field="idx:code" value={idxForm.code} onChange={v => setIdxForm({ ...idxForm, code: v })} placeholder="sh000001 / ixic" /></div>
            </div>
            <div className="form-row" style={{ marginTop: 10 }}>
              <div style={{ flex: 1 }}><div className="form-label">指数名称（可留空）</div><HistInput field="idx:name" value={idxForm.name} onChange={v => setIdxForm({ ...idxForm, name: v })} placeholder="留空则自动识别" /></div>
            </div>
            <div className="form-row" style={{ marginTop: 8 }}>
              <div style={{ flex: 1, fontSize: 12, color: 'var(--muted)' }}>期货指数快捷添加：
                <button className="btn-ghost btn-sm" style={{ marginLeft: 6 }} onClick={() => addFuturesIndex('纽约金', 'hf_GC')}>纽约金</button>
                <button className="btn-ghost btn-sm" onClick={() => addFuturesIndex('沪金', 'nf_AU0')}>沪金</button>
                <button className="btn-ghost btn-sm" onClick={() => addFuturesIndex('伦敦金', 'hf_XAU')}>伦敦金</button>
                <span style={{ marginLeft: 8 }}>（纽约金=COMEX黄金 hf_GC / 沪金=上期所黄金连续 nf_AU0 / 伦敦金=现货黄金 hf_XAU）</span>
              </div>
            </div>
            <div className="form-actions">
              <button className="btn-ghost" onClick={() => setShowAddIndex(false)}>取消</button>
              <button className="btn" onClick={addIndex}>添加指数</button>
            </div>
          </div>
        </div>
      )}

      {/* 基金详情模态 */}
      {fundDetail && (
        <div className="modal show" onClick={() => setFundDetail(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ width: 760 }}>
            <div className="modal-head">
              <h3>{fundDetail.nav.name} · 基金详情</h3>
              <button className="modal-close" onClick={() => setFundDetail(null)}>×</button>
            </div>
            <div className="fund-info">
              <div className="fi"><div className="l">最新净值</div><div className="v">{fmt(fundDetail.nav.nav, 4)}</div></div>
              <div className="fi"><div className="l">日涨跌幅</div><div className={`v ${cls(fundDetail.nav.pct)}`}>{sign(fundDetail.nav.pct)}%</div></div>
              <div className="fi"><div className="l">累计净值</div><div className="v">{fmt(fundDetail.nav.acc_nav, 4)}</div></div>
            </div>
            <div className="card-title" style={{ marginTop: 14 }}>📈 净值 K 线</div>
            <KlineChart market="FUND" code={fundDetail.nav.code} />
            <div className="card-title" style={{ marginTop: 14 }}>🔍 场内穿透估算</div>
            {penLoading
              ? <div className="loading">穿透估算加载中…</div>
              : <PenetrationView pen={fundPen} />}
          </div>
        </div>
      )}
    </section>
  )
}
