import React, { useState, useEffect } from 'react'
import ProfitDisplay from '../components/ProfitDisplay.jsx'
import { api } from '../api.js'
import { useInputHistory, clearHistory, loadHistory } from '../history.js'

// 带历史记忆的输入框：记忆最近 5 个值，点击下拉可快速回填
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
// v21：场外基金净值显示 4 位小数，其他市场 2 位
const pfmt = (n, market) => (n == null ? '—' : fmt(n, market === 'FUND' ? 4 : 2))

export default function Positions() {
  const [positions, setPositions] = useState([])
  const [txns, setTxns] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [editTxn, setEditTxn] = useState(null)  // 正在编辑的交易
  const [form, setForm] = useState({ market: 'A股', code: '', side: 'BUY', quantity: '', price: '', fee: 0, trans_date: new Date().toISOString().split('T')[0], note: '', fund_time: 'before' })
  // 基金是否 QDII（非国内基金，确认 T+2）：
  //   qdiiAuto = 系统按代码自动识别（内置清单）；qdiiManual = 用户手动勾选（兜底未收录代码）
  const [qdiiAuto, setQdiiAuto] = useState(false)
  const [qdiiManual, setQdiiManual] = useState(false)
  const isQdii = qdiiAuto || qdiiManual
  // 实物黄金
  const [gold, setGold] = useState(null)
  const [goldForm, setGoldForm] = useState({ grams: '', cost_price: '' })
  // 实物黄金交易流水（买入/卖出录入）
  const [goldTxns, setGoldTxns] = useState([])
  const [goldTxnForm, setGoldTxnForm] = useState({ side: 'BUY', grams: '', price: '', trans_date: new Date().toISOString().split('T')[0], note: '' })
  // 持仓编辑
  const [editPos, setEditPos] = useState(null)  // 正在编辑的持仓
  const [posForm, setPosForm] = useState({ quantity: '', cost: '' })
  // 持仓排序：'pnl'（按持仓收益，默认）| 'mv'（按市值）| 'cost'（按成本）
  const [posSort, setPosSort] = useState('pnl')
  // 持仓置顶（后端持久化，置顶数量不限）
  const [pins, setPins] = useState([])
  // 持仓明细分页（每页 20 条）
  const [posPage, setPosPage] = useState(1)
  // 黄金交易流水分页（每页 5 条）
  const [goldPage, setGoldPage] = useState(1)
  // 新增初始持仓（直接录入，不用通过交易）
  const [showAddPos, setShowAddPos] = useState(false)
  const [addPosForm, setAddPosForm] = useState({ market: 'A股', code: '', amount: '', pnl: '' })
  const [addPosResult, setAddPosResult] = useState(null)  // 后端返回的计算结果
  const [addPosLoading, setAddPosLoading] = useState(false)
  // 批量导入：addPosMode='single'（单条）| 'batch'（批量）；batchText 为多行文本；batchResults 为逐条结果
  const [addPosMode, setAddPosMode] = useState('single')
  const [addPosBatchMarket, setAddPosBatchMarket] = useState('A股')
  const [batchText, setBatchText] = useState('')
  const [batchResults, setBatchResults] = useState(null)
  // 数据导入导出（跨机器迁移持仓等全部用户数据）
  const [exportInfo, setExportInfo] = useState(null)   // 项目根目录导出文件信息
  const [dataBusy, setDataBusy] = useState(false)      // 导入导出操作中
  const [dataMsg, setDataMsg] = useState(null)         // 操作结果提示

  const fetchData = async () => {
    try {
      const [p, t] = await Promise.all([api.positions(), api.transactions()])
      setPositions(p)
      setTxns(t)
    } catch {}
    try { setGold(await api.gold()) } catch {}
    try { setGoldTxns(await api.goldTxns()) } catch {}
    try { setPins(await api.positionPins()) } catch {}
  }

  // 录入实物黄金买卖（买入加权加仓、卖出按均价减仓，收益随实时金价自动计算）
  const submitGoldTxn = async () => {
    const grams = parseFloat(goldTxnForm.grams)
    const price = parseFloat(goldTxnForm.price)
    if (isNaN(grams) || grams <= 0) { alert('请输入有效的买卖克数'); return }
    if (isNaN(price) || price <= 0) { alert('请输入有效的成交价格'); return }
    if (!goldTxnForm.trans_date) { alert('请选择成交日期'); return }
    try {
      await api.addGoldTxn(goldTxnForm.side, grams, price, goldTxnForm.trans_date, goldTxnForm.note)
      alert(`已录入实物黄金${goldTxnForm.side === 'BUY' ? '买入' : '卖出'}，持仓与收益已更新`)
      setGoldTxnForm({ side: 'BUY', grams: '', price: '', trans_date: new Date().toISOString().split('T')[0], note: '' })
      fetchData()
    } catch (e) { alert(e.message) }
  }

  // 删除一笔实物黄金交易（按剩余流水重放重建持仓）
  const delGoldTxn = async (id) => {
    if (!window.confirm('确定删除该笔实物黄金交易吗？持仓将按剩余流水重新计算。')) return
    try {
      await api.delGoldTxn(id)
      alert('交易已删除，持仓已重算')
      fetchData()
    } catch (e) { alert(e.message) }
  }

  // 打开编辑持仓
  const openEditPos = (p) => {
    setEditPos(p)
    setPosForm({ quantity: String(p.quantity), cost: String(p.cost) })
  }

  // 保存持仓数量/成本
  const savePos = async () => {
    const qty = parseFloat(posForm.quantity)
    const cost = parseFloat(posForm.cost)
    if (isNaN(qty) || qty <= 0) { alert('请输入有效的持仓数量'); return }
    if (isNaN(cost) || cost < 0) { alert('请输入有效的持仓成本'); return }
    try {
      await api.savePositionOverride(editPos.market, editPos.code, qty, cost)
      alert('持仓已更新')
      setEditPos(null)
      fetchData()
    } catch (e) { alert(e.message) }
  }

  // 删除持仓
  const deletePos = async (p) => {
    if (!window.confirm(`确定删除「${p.name || p.code}」的持仓吗？将删除该资产的全部交易记录。`)) return
    try {
      await api.deletePosition(p.market, p.code)
      alert('持仓已删除')
      fetchData()
    } catch (e) { alert(e.message) }
  }

  // 新增初始持仓：输入代码/持有金额/持有收益，后端用当日价格自动计算数量与成本
  const marketMap = { 'A股': 'A', '美股': 'US', '港股': 'HK', '黄金': 'GOLD', '基金': 'FUND', '债券': 'BOND' }
  const submitAddPos = async () => {
    const code = (addPosForm.code || '').trim()
    const amount = parseFloat(addPosForm.amount)
    const pnl = parseFloat(addPosForm.pnl)
    if (!code) { alert('请填写产品代码'); return }
    if (isNaN(amount) || amount <= 0) { alert('请输入有效的持有金额'); return }
    if (addPosForm.pnl && isNaN(pnl)) { alert('持有收益须为数字（可留空）'); return }
    setAddPosLoading(true)
    setAddPosResult(null)
    try {
      const r = await api.addManualPosition(marketMap[addPosForm.market] || 'A', code, amount, pnl || 0)
      setAddPosResult(r)
      fetchData()
    } catch (e) { alert(e.message) } finally { setAddPosLoading(false) }
  }

  // 关闭新增持仓弹窗
  const closeAddPos = () => {
    setShowAddPos(false)
    setAddPosResult(null)
    setAddPosForm({ market: 'A股', code: '', amount: '', pnl: '' })
    setAddPosMode('single')
    setBatchText('')
    setBatchResults(null)
  }

  // ---- 数据导入导出 ----
  // 查询项目根目录是否存在导出文件
  const refreshExportInfo = async () => {
    try { setExportInfo(await api.dataExportInfo()) } catch {}
  }
  useEffect(() => { refreshExportInfo() }, [])
  // 导出：后端生成 JSON 文件到项目根目录，浏览器下载
  const doExport = async () => {
    setDataBusy(true); setDataMsg(null)
    try {
      api.dataExportDownload()
      await new Promise(r => setTimeout(r, 800))  // 等文件落盘
      await refreshExportInfo()
      setDataMsg({ ok: true, text: '✅ 已生成备份文件「持仓数据_export.json」并开始下载，请保存在安全位置。' })
    } catch (e) { setDataMsg({ ok: false, text: '导出失败：' + e.message }) }
    finally { setDataBusy(false) }
  }
  // 导入：从项目根目录的导出文件整体恢复数据（先清空现有数据）
  const doImport = async () => {
    if (!window.confirm('导入将【覆盖】当前机器上的全部数据（自选/交易/持仓/收益等），且不可撤销。\n\n确定用项目根目录的「持仓数据_export.json」导入吗？')) return
    setDataBusy(true); setDataMsg(null)
    try {
      const r = await api.dataImport()
      const s = r.imported
      setDataMsg({ ok: true, text: `✅ 导入成功（来自 ${r.exported_at}）\n自选 ${s.watchlist} · 交易 ${s.transactions} · 快照 ${s.snapshots} · 实物黄金 ${s.gold ? '是' : '否'} · 收益覆盖 ${s.asset_profit} · 持仓覆盖 ${s.position_override}` })
      fetchData()
      await refreshExportInfo()
    } catch (e) { setDataMsg({ ok: false, text: '导入失败：' + e.message }) }
    finally { setDataBusy(false) }
  }

  // 解析批量文本：每行「代码 持有金额 [持有收益]」，分隔符支持空格/Tab/逗号/顿号
  const parseBatchLines = (text) => {
    return text.split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .map(l => l.split(/[\s,，、;；\t]+/).filter(x => x.length > 0))
      .filter(parts => parts.length >= 2)
      .map(parts => ({
        market: marketMap[addPosBatchMarket] || 'A',
        code: parts[0],
        amount: parseFloat(parts[1]),
        pnl: parts[2] !== undefined ? parseFloat(parts[2]) : 0,
        raw: parts.join(' '),
      }))
  }

  // 批量导入：解析文本 → 校验 → 调批量接口 → 展示逐条结果
  const submitAddPosBatch = async () => {
    const lines = parseBatchLines(batchText)
    if (lines.length === 0) { alert('未解析到有效数据。请每行输入：代码 持有金额 [持有收益]'); return }
    const invalid = lines.filter(x => isNaN(x.amount) || x.amount <= 0)
    if (invalid.length > 0) {
      alert(`以下行「持有金额」无效：\n${invalid.map(x => '· ' + x.raw).join('\n')}\n\n请填写正数的持有金额，可再用空格附加持有收益。`)
      return
    }
    setAddPosLoading(true)
    setBatchResults(null)
    try {
      const r = await api.addManualPositionBatch(lines)
      setBatchResults(r)
      fetchData()
    } catch (e) { alert(e.message) } finally { setAddPosLoading(false) }
  }

  // 置顶集合（market:code → true）
  const pinnedSet = (() => {
    const s = {}
    ;(pins || []).forEach(p => { s[p.market + ':' + p.code] = true })
    return s
  })()

  // 排序后的持仓：默认按持仓收益降序；可切换按市值/成本；
  // 用户置顶的产品永远排在列表最前面（置顶数量不限）。
  // v21 修复：
  //   1) comparator 增加次级稳定键 (market, code)，避免主排序键坍缩（行情不可用时
  //      market_value 回退为 cost、holdingPnl=0）导致三键结果一致、列表"看起来不变"。
  //   2) 修复置顶排序方向（之前 b - a 写反，置顶的产品反而排到了最后）。
  const sortedPositions = (() => {
    let list = [...positions]
    const keyOf = posSort === 'cost' ? p => p.cost
      : posSort === 'mv' ? p => p.market_value
      : p => (p.holdingPnl != null ? p.holdingPnl : p.pnl)  // 默认 pnl
    list.sort((a, b) => {
      const va = keyOf(a) || 0, vb = keyOf(b) || 0
      if (vb !== va) return vb - va
      // 次级稳定键：(market, code) 升序
      const ka = (a.market || '') + ':' + (a.code || '')
      const kb = (b.market || '') + ':' + (b.code || '')
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
    // 置顶优先（a 置顶 → 返回 1，a 排前面）
    list.sort((a, b) => Number(!!pinnedSet[a.market + ':' + a.code]) - Number(!!pinnedSet[b.market + ':' + b.code]))
    return list
  })()

  // 置顶/取消置顶
  const togglePin = async (p) => {
    const pinned = !!pinnedSet[p.market + ':' + p.code]
    try {
      if (pinned) await api.unpinPosition(p.market, p.code)
      else await api.pinPosition(p.market, p.code)
      fetchData()
    } catch (e) { alert(e.message) }
  }

  // 持仓明细分页（每页 20 条）
  const POS_PAGE_SIZE = 20
  const posTotalPages = Math.max(1, Math.ceil(sortedPositions.length / POS_PAGE_SIZE))
  const curPosPage = Math.min(posPage, posTotalPages)
  const pagePositions = sortedPositions.slice((curPosPage - 1) * POS_PAGE_SIZE, curPosPage * POS_PAGE_SIZE)

  // 黄金交易流水分页（每页 5 条）
  const GOLD_PAGE_SIZE = 5
  const goldTotalPages = Math.max(1, Math.ceil(goldTxns.length / GOLD_PAGE_SIZE))
  const curGoldPage = Math.min(goldPage, goldTotalPages)
  const pageGoldTxns = goldTxns.slice((curGoldPage - 1) * GOLD_PAGE_SIZE, curGoldPage * GOLD_PAGE_SIZE)

  // 计算基金份额确认日期（跳过周末，不含法定节假日）
  // 规则：境内普通基金 15:00前→T+1、15:00后→T+2；
  //       QDII（非国内）基金无论何时提交，确认份额均为 T+2。
  const nextTradingDay = (dateStr, offsetDays) => {
    const d = new Date(dateStr + 'T00:00:00')
    let added = 0
    while (added < offsetDays) {
      d.setDate(d.getDate() + 1)
      const day = d.getDay()
      if (day !== 0 && day !== 6) added++  // 跳过周六(0)周日(6)
    }
    return d.toISOString().split('T')[0]
  }
  // 基金确认：QDII 恒为 T+2；境内基金按 15:00 前后分 T+1 / T+2
  const fundTPlus = isQdii ? 2 : (form.fund_time === 'after' ? 2 : 1)
  const fundConfirmDate = nextTradingDay(form.trans_date, fundTPlus)
  const fundRuleText = isQdii ? 'QDII基金' : (form.fund_time === 'after' ? '15:00后' : '15:00前')
  const isFundTxn = form.market === '基金'
  const showFundTime = isFundTxn

  // 录入/编辑基金时，自动判断该代码是否为 QDII（非国内）基金（内置清单）
  const checkQdii = async (code) => {
    const c = (code || '').trim()
    if (!isFundTxn || !c) { setQdiiAuto(false); return }
    try {
      const r = await api.fundQdiiCheck(c)
      setQdiiAuto(!!(r && r.is_qdii))
    } catch { setQdiiAuto(false) }
  }
  // 基金代码变化时：触发自动判定，并重置手动标记（用户可能改成了另一个基金）
  useEffect(() => {
    setQdiiManual(false)
    checkQdii(form.code)
  }, [form.code, form.market])

  useEffect(() => { fetchData() }, [])

  const submitGold = async () => {
    const grams = parseFloat(goldForm.grams)
    const cost = parseFloat(goldForm.cost_price)
    if (isNaN(grams) || grams < 0 || isNaN(cost) || cost < 0) { alert('请填写有效的克数和成本价'); return }
    try {
      await api.saveGold(grams, cost)
      alert('实物黄金已保存')
      setGoldForm({ grams: '', cost_price: '' })
      fetchData()
    } catch (e) { alert(e.message) }
  }

  const deleteGold = async () => {
    if (!window.confirm('确定清空实物黄金持仓吗？')) return
    try {
      await api.delGold()
      alert('实物黄金已清空')
      setGoldForm({ grams: '', cost_price: '' })
      fetchData()
    } catch (e) { alert(e.message) }
  }

  const submit = async () => {
    if (!form.code || !form.quantity || !form.price) { alert('请填写代码、数量、价格'); return }
    const marketMap = { 'A股': 'A', '美股': 'US', '港股': 'HK', '黄金': 'GOLD', '基金': 'FUND', '债券': 'BOND' }
    // 基金：把交易时间与确认份额日期（含 QDII 判定）写入备注，便于追溯
    let note = form.note || ''
    if (form.market === '基金' && form.trans_date) {
      const t = isQdii ? 'QDII基金' : (form.fund_time === 'after' ? '15:00后' : '15:00前')
      note = `${note} [${t} 确认${fundConfirmDate}]`.trim()
    }
    try {
      await api.addTxn({
        ...form,
        market: marketMap[form.market] || 'A',
        quantity: parseFloat(form.quantity),
        price: parseFloat(form.price),
        fee: parseFloat(form.fee || 0),
        note,
      })
      setShowForm(false)
      setForm({ market: 'A股', code: '', side: 'BUY', quantity: '', price: '', fee: 0, trans_date: new Date().toISOString().split('T')[0], note: '', fund_time: 'before' })
      setQdiiAuto(false); setQdiiManual(false)
      fetchData()
    } catch (e) { alert(e.message) }
  }

  // 打开编辑交易弹窗
  const openEdit = (t) => {
    const marketMapRev = { A: 'A股', US: '美股', HK: '港股', GOLD: '黄金', FUND: '基金', BOND: '债券' }
    setEditTxn(t)
    setQdiiAuto(false); setQdiiManual(false)
    setForm({
      market: marketMapRev[t.market] || 'A股',
      code: t.code,
      side: t.side,
      quantity: String(t.quantity),
      price: String(t.price),
      fee: t.fee || 0,
      trans_date: t.trans_date,
      note: t.note || '',
    })
  }

  // 保存编辑交易
  const saveEdit = async () => {
    if (!form.code || !form.quantity || !form.price) { alert('请填写代码、数量、价格'); return }
    const marketMap = { 'A股': 'A', '美股': 'US', '港股': 'HK', '黄金': 'GOLD', '基金': 'FUND', '债券': 'BOND' }
    try {
      await api.updateTxn(editTxn.id, {
        market: marketMap[form.market] || 'A',
        code: form.code,
        side: form.side,
        quantity: parseFloat(form.quantity),
        price: parseFloat(form.price),
        fee: parseFloat(form.fee || 0),
        trans_date: form.trans_date,
        note: form.note,
      })
      setEditTxn(null)
      setForm({ market: 'A股', code: '', side: 'BUY', quantity: '', price: '', fee: 0, trans_date: new Date().toISOString().split('T')[0], note: '' })
      fetchData()
    } catch (e) { alert(e.message) }
  }

  const remove = async (id) => {
    if (!window.confirm('确定删除该交易记录吗？')) return
    await api.delTxn(id)
    fetchData()
  }

  return (
    <section className="page active">
      <div className="page-head">
        <div>
          <div className="page-title">持仓管理</div>
          <div className="page-sub">持仓明细 · 交易记录</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-ghost" onClick={fetchData} title="立即刷新">⟳ 刷新</button>
          <button className="btn-ghost" onClick={() => setShowAddPos(true)} title="直接录入初始持仓，无需通过交易记录">＋ 新增持仓</button>
          <button className="btn" onClick={() => setShowForm(true)}>＋ 录入交易</button>
        </div>
      </div>

      <div className="pos-grid">
        {pagePositions.map(p => (
          <div key={p.code + p.market} className="pos-card">
            <div className="top">
              {pinnedSet[p.market + ':' + p.code] && <span style={{ marginRight: 4 }} title="已置顶">📌</span>}
              <span className="name">{p.name || p.code}</span><span className="code">{p.code} · {p.market}</span>
              {p.sold_out && <span className="sold-out-badge" title="该产品已全部卖出，保留累计收益记录">已清仓</span>}
            </div>
            {p.data_available === false
              ? <div className="empty" style={{ margin: '8px 0' }}>实时行情数据暂不可用</div>
              : p.sold_out ? (
                <div className="big" style={{ color: 'var(--muted)' }}>已清仓</div>
              ) : <>
                  <div className={`big ${cls(p.pnl)}`}>{sign(p.pnl)}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 12 }}>{sign(p.pnl_pct)}%</div>
                </>}
            <div className="pos-row"><span>数量</span><b>{p.sold_out ? '—' : fmt(p.quantity, p.is_physical_gold ? 2 : 0)}</b></div>
            <div className="pos-row"><span>持仓成本</span><b>{p.sold_out ? '—' : money(p.cost)}</b></div>
            <div className="pos-row"><span>现价 / 市值</span><b>{p.sold_out ? <span className="muted">— / —</span> : (p.data_available === false ? <span className="muted">— / —</span> : `${pfmt(p.price, p.market)} / ${money(p.market_value)}`)}</b></div>
            {p.sold_out && (
              <div className="pos-row"><span>累计收益</span><b className={cls(p.cumPnl)}>{sign(p.cumPnl)}</b></div>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-title">
          持仓明细
          <span className="pc-sub" style={{ marginLeft: 10, fontSize: 12 }}>
            排序：
            <button type="button" className="btn-ghost btn-sm" onClick={() => setPosSort('pnl')}>{posSort === 'pnl' ? '按持仓收益 ✓' : '按持仓收益'}</button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setPosSort('mv')}>{posSort === 'mv' ? '按市值 ✓' : '按市值'}</button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setPosSort('cost')}>{posSort === 'cost' ? '按持仓成本 ✓' : '按持仓成本'}</button>
          </span>
          <span className="pc-sub" style={{ marginLeft: 10, fontSize: 12 }}>📌 置顶的产品永远排在列表最前</span>
        </div>
        <table>
          <thead><tr><th>名称</th><th>市场</th><th className="num">数量</th><th className="num">持仓成本</th><th className="num">现价</th><th className="num">市值</th><th>收益</th><th>操作</th></tr></thead>
          <tbody>
            {pagePositions.map(p => (
              <tr key={p.code + p.market}>
                <td>
                  {pinnedSet[p.market + ':' + p.code] && <span style={{ marginRight: 6 }} title="已置顶">📌</span>}
                  {p.name || p.code}
                  {p.overridden && <span className="badge badge-gold" style={{ marginLeft: 6 }}>已编辑</span>}
                  {p.sold_out && <span className="sold-out-badge" style={{ marginLeft: 6 }}>已清仓</span>}
                </td>
                <td><span className="badge badge-a">{p.market}</span></td>
                <td className="num">{p.sold_out ? '—' : fmt(p.quantity, p.is_physical_gold ? 2 : 0)}</td>
                <td className="num">{p.sold_out ? '—' : money(p.cost)}</td>
                <td className="num">{p.data_available === false ? <span className="muted">数据暂不可用</span> : (p.sold_out ? '—' : pfmt(p.price, p.market))}</td>
                <td className="num">{p.data_available === false ? <span className="muted">—</span> : (p.sold_out ? '—' : money(p.market_value))}</td>
                <td>
                  {p.data_available === false ? <span className="muted">数据暂不可用</span> : (
                    <ProfitDisplay
                      market={p.market} code={p.code}
                      holdingPnl={p.holdingPnl} cumPnl={p.cumPnl}
                      holdingPnlEdited={p.holdingPnlEdited} cumPnlEdited={p.cumPnlEdited}
                      size="sm" onSaved={fetchData}
                    />
                  )}
                </td>
                <td className="op-col">
                  {/* v21：实物黄金也支持在持仓明细中编辑（克数=quantity / 总成本=cost），
                      复用 openEditPos → savePositionOverride → 后端 save_position_override 兼容 GOLD → save_gold_holding。
                      售罄行仍屏蔽「编辑」按钮（无数量可编辑），保留「置顶」「删除」。 */}
                  {p.sold_out ? (
                    <>
                      <button className="btn btn-sm" style={{ marginRight: 6 }} onClick={() => togglePin(p)} title={pinnedSet[p.market + ':' + p.code] ? '取消置顶' : '置顶该产品（数量不限），置顶后永远排在列表最前'}>
                        {pinnedSet[p.market + ':' + p.code] ? '📌 已置顶' : '置顶'}
                      </button>
                      <button className="btn-danger" onClick={() => deletePos(p)}>删除</button>
                    </>
                  ) : (
                    <>
                      <button className="btn btn-sm" style={{ marginRight: 6 }} onClick={() => togglePin(p)} title={pinnedSet[p.market + ':' + p.code] ? '取消置顶' : '置顶该产品（数量不限），置顶后永远排在列表最前'}>
                        {pinnedSet[p.market + ':' + p.code] ? '📌 已置顶' : '置顶'}
                      </button>
                      <button className="btn btn-sm" style={{ marginRight: 6 }} onClick={() => openEditPos(p)}>编辑</button>
                      <button className="btn-danger" onClick={() => deletePos(p)}>删除</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {positions.length === 0 && <div className="empty">暂无持仓</div>}
        {positions.length > POS_PAGE_SIZE && (
          <div className="pager" style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, justifyContent: 'flex-end' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>共 {positions.length} 条 · 第 {curPosPage} / {posTotalPages} 页（每页 {POS_PAGE_SIZE} 条）</span>
            <button className="btn-ghost btn-sm" disabled={curPosPage <= 1} onClick={() => setPosPage(curPosPage - 1)}>‹ 上一页</button>
            <button className="btn-ghost btn-sm" disabled={curPosPage >= posTotalPages} onClick={() => setPosPage(curPosPage + 1)}>下一页 ›</button>
          </div>
        )}
      </div>

      {/* 编辑持仓模态 */}
      {editPos && (
        <div className="modal show" onClick={() => setEditPos(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>编辑持仓 · {editPos.name || editPos.code} ({editPos.code})</h3>
              <button className="modal-close" onClick={() => setEditPos(null)}>×</button>
            </div>
            <div className="form">
              <div className="form-label">持仓数量</div>
              <input className="form-input" type="number" min="0" step="any"
                value={posForm.quantity} onChange={e => setPosForm({ ...posForm, quantity: e.target.value })} />
              <div className="form-label" style={{ marginTop: 12 }}>持仓总成本（元）</div>
              <input className="form-input" type="number" min="0" step="0.01"
                value={posForm.cost} onChange={e => setPosForm({ ...posForm, cost: e.target.value })} />
              <div style={{ marginTop: 16, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button className="btn-ghost" onClick={() => setEditPos(null)}>取消</button>
                <button className="btn" onClick={savePos}>保存</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 新增初始持仓模态 */}
      {showAddPos && (
        <div className="modal show" onClick={closeAddPos}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>＋ 新增持仓</h3>
              <button className="modal-close" onClick={closeAddPos}>×</button>
            </div>
            {/* 模式切换：单条 / 批量 */}
            <div className="form-row" style={{ marginBottom: 12, alignItems: 'center' }}>
              <div className="seg" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
                <button className={`seg-btn ${addPosMode === 'single' ? 'active' : ''}`} style={{ padding: '6px 14px', fontSize: 13, background: addPosMode === 'single' ? 'var(--accent)' : 'transparent', color: addPosMode === 'single' ? '#fff' : 'var(--text)', border: 'none', cursor: 'pointer' }} onClick={() => { setAddPosMode('single'); setBatchResults(null) }}>单条录入</button>
                <button className={`seg-btn ${addPosMode === 'batch' ? 'active' : ''}`} style={{ padding: '6px 14px', fontSize: 13, background: addPosMode === 'batch' ? 'var(--accent)' : 'transparent', color: addPosMode === 'batch' ? '#fff' : 'var(--text)', border: 'none', cursor: 'pointer', borderLeft: '1px solid var(--border)' }} onClick={() => { setAddPosMode('batch'); setAddPosResult(null) }}>批量导入</button>
              </div>
            </div>

            {addPosMode === 'single' ? (
              <>
                <div className="pc-sub" style={{ marginBottom: 10, fontSize: 12, color: 'var(--muted)' }}>
                  直接录入初始持仓，无需通过交易记录。输入产品代码与持有金额（当前市值）、持有收益（浮动盈亏），系统用<b>当日价格</b>自动计算持仓数量与成本。
                </div>
                <div className="form-row">
                  <div><div className="form-label">市场</div>
                    <select className="form-input" value={addPosForm.market} onChange={e => setAddPosForm({ ...addPosForm, market: e.target.value })}>
                      <option>A股</option><option>美股</option><option>港股</option><option>基金</option><option>债券</option><option>黄金</option>
                    </select></div>
                  <div><div className="form-label">产品代码</div><HistInput field="pos:code" value={addPosForm.code} onChange={v => setAddPosForm({ ...addPosForm, code: v })} placeholder="sh600519 / 161725 / aapl" /></div>
                </div>
                <div className="form-row">
                  <div><div className="form-label">持有金额（元）</div><HistInput field="pos:amount" type="number" min="0" value={addPosForm.amount} onChange={v => setAddPosForm({ ...addPosForm, amount: v })} placeholder="当前市值" /></div>
                  <div><div className="form-label">持有收益（元）</div><HistInput field="pos:pnl" type="number" value={addPosForm.pnl} onChange={v => setAddPosForm({ ...addPosForm, pnl: v })} placeholder="浮动盈亏，可留空" /></div>
                </div>
                {addPosResult && (
                  <div className="fund-confirm-hint" style={{ display: 'block', marginTop: 10 }}>
                    ✅ 已按当日价格计算：
                    <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text)' }}>
                      <b>{addPosResult.name}</b>（{addPosResult.code}）· 现价 ¥{pfmt(addPosResult.price, addPosResult.market)}<br />
                      持仓数量 ≈ <b>{fmt(addPosResult.quantity, 4)}</b> · 持仓成本 <b>{money(addPosResult.cost)}</b><br />
                      市值 {money(addPosResult.market_value)} · 收益 <b className={cls(addPosResult.pnl)}>{sign(addPosResult.pnl)}</b>
                    </div>
                  </div>
                )}
                <div className="form-actions">
                  <button className="btn-ghost" onClick={closeAddPos}>取消</button>
                  <button className="btn" onClick={submitAddPos} disabled={addPosLoading}>
                    {addPosLoading ? '计算中…' : (addPosResult ? '重新计算' : '计算并新增')}
                  </button>
                  {addPosResult && <button className="btn" onClick={closeAddPos}>完成</button>}
                </div>
              </>
            ) : (
              <>
                <div className="pc-sub" style={{ marginBottom: 10, fontSize: 12, color: 'var(--muted)' }}>
                  批量导入初始持仓：每行 <b>代码 持有金额 [持有收益]</b>，用空格 / Tab / 逗号分隔，持有收益可留空。
                  <br />例：<code style={{ background: 'var(--bg)', padding: '2px 6px', borderRadius: 4 }}>sh600519 100000 15000</code>
                </div>
                <div className="form-row">
                  <div><div className="form-label">市场（适用于整批）</div>
                    <select className="form-input" value={addPosBatchMarket} onChange={e => setAddPosBatchMarket(e.target.value)}>
                      <option>A股</option><option>美股</option><option>港股</option><option>基金</option><option>债券</option><option>黄金</option>
                    </select></div>
                </div>
                <div className="form-label">批量内容（一行一条）</div>
                <textarea className="form-input" rows={7} value={batchText}
                  placeholder={'代码 持有金额 持有收益\nsh600519 100000 15000\n161725 50000\naapl 20000 -1000'}
                  onChange={e => setBatchText(e.target.value)} style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }} />
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
                  当前解析到 <b>{parseBatchLines(batchText).length}</b> 条有效记录
                </div>
                {batchResults && (
                  <div className="fund-confirm-hint" style={{ display: 'block', marginTop: 10 }}>
                    📊 批量导入结果：成功 <b style={{ color: 'var(--up, #e4572e)' }}>{batchResults.success}</b> / {batchResults.total}，失败 <b style={{ color: 'var(--down, #0aa858)' }}>{batchResults.failed}</b>
                    <div style={{ maxHeight: 160, overflowY: 'auto', marginTop: 8, fontSize: 13 }}>
                      {batchResults.results.map((r, i) => {
                        const d = r.data || {}
                        const dispCode = d.code || r.code || '—'
                        const dispMarket = d.market || r.market || '—'
                        return (
                          <div key={i} style={{ padding: '3px 0', color: r.success ? 'var(--text)' : 'var(--down, #0aa858)' }}>
                            {r.success ? '✅' : '❌'} {dispCode}（{dispMarket}）·
                            {r.success
                              ? <> 现价 {money(d.price)} · 数量 ≈ {fmt(d.quantity, 4)} · 成本 {money(d.cost)}</>
                              : <> <span className="muted">{r.error}</span></>}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
                <div className="form-actions">
                  <button className="btn-ghost" onClick={closeAddPos}>取消</button>
                  <button className="btn" onClick={submitAddPosBatch} disabled={addPosLoading || parseBatchLines(batchText).length === 0}>
                    {addPosLoading ? '导入中…' : `批量导入（${parseBatchLines(batchText).length} 条）`}
                  </button>
                  {batchResults && <button className="btn" onClick={closeAddPos}>完成</button>}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">交易记录</div>
        <table>
          <thead><tr><th>日期</th><th>代码</th><th>市场</th><th>方向</th><th className="num">数量</th><th className="num">价格</th><th className="num">手续费</th><th>操作</th></tr></thead>
          <tbody>
            {txns.map(t => (
              <tr key={t.id}>
                <td>{t.trans_date}</td><td>{t.code}</td>
                <td><span className="badge badge-a">{t.market}</span></td>
                <td><span className={`badge ${t.side === 'BUY' ? 'badge-a' : 'badge-u'}`}>{t.side === 'BUY' ? '买入' : '卖出'}</span></td>
                <td className="num">{fmt(t.quantity)}</td>
                <td className="num">{fmt(t.price)}</td>
                <td className="num">{fmt(t.fee)}</td>
                <td>
                  <button className="btn btn-sm" style={{ marginRight: 6 }} onClick={() => openEdit(t)}>编辑</button>
                  <button className="btn-danger" onClick={() => remove(t.id)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {txns.length === 0 && <div className="empty">暂无交易记录</div>}
      </div>

      {/* 实物黄金（置于页面最下方） */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">实物黄金（按人民币/克估值）</div>
        {/* v21：删除「保存实物黄金」按钮 + 输入框，改为在「持仓明细」表里编辑克数/总成本
            （行内点「编辑」→ 后端 save_position_override 兼容 GOLD → save_gold_holding）。
            流水录入仍是增减克数的入口；此处只保留「清空」作为兜底重置。 */}
        <div className="pc-sub" style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
          💡 实物黄金的克数与总成本，请在「持仓明细」表里点击 <b>编辑</b> 修改；下方可继续录入买卖流水。
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
          {gold && gold.grams > 0 && <button className="btn-danger" onClick={deleteGold}>清空实物黄金</button>}
        </div>
        {gold && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginTop: 16 }}>
            <div className="pos-row" style={{ border: '1px solid var(--border)', padding: '10px 14px', borderRadius: 8, minWidth: 160 }}>
              <span>实时金价</span><b>{gold.price_available ? '¥' + fmt(gold.price) + ' /克' : '数据暂不可用'}</b>
              {gold.price_available && <div style={{ color: cls(gold.price_pct), fontSize: 12 }}>{sign(gold.price_pct)}%</div>}
            </div>
            <div className="pos-row" style={{ border: '1px solid var(--border)', padding: '10px 14px', borderRadius: 8, minWidth: 160 }}>
              <span>黄金市值</span><b>{gold.market_value != null ? money(gold.market_value) : '数据暂不可用'}</b>
            </div>
            <div className="pos-row" style={{ border: '1px solid var(--border)', padding: '10px 14px', borderRadius: 8, minWidth: 160 }}>
              <span>持仓成本</span><b>{money(gold.cost)}</b>
            </div>
            <div className="pos-row" style={{ border: '1px solid var(--border)', padding: '10px 14px', borderRadius: 8, minWidth: 160 }}>
              <span>盈亏</span><b className={cls(gold.pnl)}>{gold.pnl != null ? sign(gold.pnl) : '数据暂不可用'}</b>
              {gold.pnl_pct != null && <div style={{ color: cls(gold.pnl_pct), fontSize: 12 }}>{sign(gold.pnl_pct)}%</div>}
            </div>
            <div className="pos-row" style={{ border: '1px solid var(--border)', padding: '10px 14px', borderRadius: 8, minWidth: 160 }}>
              <span>已实现收益</span><b className={cls(gold.realized_pnl)}>{gold.realized_pnl != null ? sign(gold.realized_pnl) : '—'}</b>
              <div style={{ color: 'var(--muted)', fontSize: 12 }}>卖出流水累计</div>
            </div>
          </div>
        )}
        {gold && gold.grams <= 0 && <div className="empty" style={{ marginTop: 12 }}>尚未录入实物黄金，请输入克数与成本价后保存</div>}

        {/* 实物黄金交易流水：买入/卖出录入（克数 + 价格），自动更新持仓与收益（每页最多 5 条，可翻页） */}
        <div style={{ marginTop: 18, borderTop: '1px dashed var(--border)', paddingTop: 14 }}>
          <div className="card-title" style={{ marginBottom: 10 }}>📒 黄金交易流水（买入 / 卖出）
            <span className="pc-sub" style={{ marginLeft: 8, fontSize: 12 }}>按加权平均成本更新克数与成本价，收益随实时金价自动计算</span>
          </div>
          <div className="form-row" style={{ marginBottom: 10 }}>
            <div><div className="form-label">方向</div>
              <select className="form-input" value={goldTxnForm.side} onChange={e => setGoldTxnForm({ ...goldTxnForm, side: e.target.value })}>
                <option value="BUY">买入</option><option value="SELL">卖出</option>
              </select></div>
            <div><div className="form-label">克数</div><HistInput field="goldtxn:grams" type="number" min="0" step="0.01" value={goldTxnForm.grams} onChange={v => setGoldTxnForm({ ...goldTxnForm, grams: v })} placeholder="如 50" /></div>
            <div><div className="form-label">价格（元/克）</div><HistInput field="goldtxn:price" type="number" min="0" step="0.01" value={goldTxnForm.price} onChange={v => setGoldTxnForm({ ...goldTxnForm, price: v })} placeholder="如 580" /></div>
            <div><div className="form-label">日期</div><HistInput field="goldtxn:date" type="date" value={goldTxnForm.trans_date} onChange={v => setGoldTxnForm({ ...goldTxnForm, trans_date: v })} /></div>
            <div><div className="form-label">备注</div><HistInput field="goldtxn:note" value={goldTxnForm.note} onChange={v => setGoldTxnForm({ ...goldTxnForm, note: v })} placeholder="可选" /></div>
          </div>
          <button className="btn" onClick={submitGoldTxn} style={{ marginBottom: 10 }}>＋ 录入{goldTxnForm.side === 'BUY' ? '买入' : '卖出'}交易</button>
          {goldTxns.length > 0 ? (
            <>
              <table>
                <thead><tr><th>日期</th><th>方向</th><th className="num">克数</th><th className="num">价格（元/克）</th><th className="num">金额</th><th>备注</th><th>操作</th></tr></thead>
                <tbody>
                  {pageGoldTxns.map(t => (
                    <tr key={t.id}>
                      <td>{t.trans_date}</td>
                      <td><span className={`badge ${t.side === 'BUY' ? 'badge-a' : 'badge-u'}`}>{t.side === 'BUY' ? '买入' : '卖出'}</span></td>
                      <td className="num">{fmt(t.grams, 2)}</td>
                      <td className="num">{fmt(t.price, 2)}</td>
                      <td className="num">{money(t.grams * t.price)}</td>
                      <td><span className="muted">{t.note || '—'}</span></td>
                      <td><button className="btn-danger" onClick={() => delGoldTxn(t.id)}>删除</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="pager" style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, justifyContent: 'flex-end' }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>共 {goldTxns.length} 条 · 第 {curGoldPage} / {goldTotalPages} 页</span>
                <button className="btn-ghost btn-sm" disabled={curGoldPage <= 1} onClick={() => setGoldPage(curGoldPage - 1)}>‹ 上一页</button>
                <button className="btn-ghost btn-sm" disabled={curGoldPage >= goldTotalPages} onClick={() => setGoldPage(curGoldPage + 1)}>下一页 ›</button>
              </div>
            </>
          ) : (
            <div className="empty" style={{ padding: '14px 0' }}>暂无黄金交易流水。录入买卖后，持仓克数与成本价按加权平均自动更新。</div>
          )}
        </div>
      </div>

      {/* 数据导入导出（置于实物黄金下方，页面最底部） */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">数据导入 / 导出（跨机器迁移）</div>
        <div className="pc-sub" style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          <b>导出</b>：把当前机器上的全部数据（自选 / 交易 / 持仓 / 收益 / 实物黄金 / 置顶 / 指数配置）保存为项目根目录下的 <code>持仓数据_export.json</code> 供下载，拷贝到另一台机器即可迁移。
          <br /><b>导入</b>：把导出文件放到<b>项目根目录（同路径）</b>后点击导入，即可整体恢复（会先清空当前机器数据）。
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <button className="btn" onClick={doExport} disabled={dataBusy}>
            {dataBusy ? '处理中…' : '⬇ 导出数据（下载备份）'}
          </button>
          <button className="btn" onClick={doImport} disabled={dataBusy}>
            {dataBusy ? '处理中…' : '⬆ 导入数据（恢复备份）'}
          </button>
          <button className="btn-ghost" onClick={refreshExportInfo} title="重新扫描项目根目录" disabled={dataBusy}>⟳ 扫描</button>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {exportInfo && exportInfo.exists
              ? <>根目录已存在备份文件：<b>自选 {exportInfo.items.watchlist}</b> · <b>交易 {exportInfo.items.transactions}</b> · 黄金 {exportInfo.items.gold ? '有' : '无'}（导出于 {exportInfo.exported_at || '未知'}）</>
              : '项目根目录暂无导出文件，可先导出。'}
          </span>
        </div>
        {dataMsg && (
          <div className="fund-confirm-hint" style={{ display: 'block', marginTop: 10, whiteSpace: 'pre-line' }}>
            {dataMsg.text}
          </div>
        )}
      </div>

      {showForm && (
        <div className="modal show" onClick={() => setShowForm(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-head"><h3>录入交易</h3><button className="modal-close" onClick={() => setShowForm(false)}>×</button></div>
            <div className="form-row">
              <div><div className="form-label">市场</div>
                <select className="form-input" value={form.market} onChange={e => setForm({ ...form, market: e.target.value })}>
                  <option>A股</option><option>美股</option><option>港股</option><option>黄金</option><option>基金</option><option>债券</option>
                </select></div>
              <div><div className="form-label">代码</div><HistInput field="txn:code" value={form.code} onChange={v => setForm({ ...form, code: v })} placeholder="sh600519" /></div>
              <div><div className="form-label">方向</div>
                <select className="form-input" value={form.side} onChange={e => setForm({ ...form, side: e.target.value })}>
                  <option value="BUY">买入</option><option value="SELL">卖出</option>
                </select></div>
            </div>
            <div className="form-row">
              <div><div className="form-label">数量</div><HistInput field="txn:qty" type="number" value={form.quantity} onChange={v => setForm({ ...form, quantity: v })} /></div>
              <div><div className="form-label">价格</div><HistInput field="txn:price" type="number" value={form.price} onChange={v => setForm({ ...form, price: v })} /></div>
              <div><div className="form-label">手续费</div><HistInput field="txn:fee" type="number" value={form.fee} onChange={v => setForm({ ...form, fee: v })} /></div>
              <div><div className="form-label">日期</div><input className="form-input" type="date" value={form.trans_date} onChange={e => setForm({ ...form, trans_date: e.target.value })} /></div>
            </div>
            <div className="form-row"><div><div className="form-label">备注</div><input className="form-input" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /></div></div>
            {showFundTime && (
              <div className="form-row" style={{ marginTop: 8 }}>
                {!isQdii && (
                  <div><div className="form-label">交易时间</div>
                    <select className="form-input" value={form.fund_time} onChange={e => setForm({ ...form, fund_time: e.target.value })}>
                      <option value="before">15:00 之前</option>
                      <option value="after">15:00 之后</option>
                    </select></div>
                )}
                <div style={{ alignSelf: 'flex-end', paddingBottom: 8 }}>
                  {/* 非国内基金（QDII）手动标记：兜底内置清单未收录的代码 */}
                  <label className="qdii-toggle" style={{ display: 'block', marginBottom: 6, cursor: 'pointer', fontSize: 13, color: 'var(--muted)' }}>
                    <input type="checkbox"
                      checked={isQdii}
                      onChange={e => setQdiiManual(e.target.checked)}
                      disabled={!!qdiiAuto}
                      style={{ marginRight: 5, cursor: 'pointer', verticalAlign: 'middle' }}
                    />
                    非国内基金（QDII，确认份额固定 T+2）
                    {qdiiAuto && <span style={{ color: 'var(--accent)', fontSize: 12, marginLeft: 4 }}>（已自动识别）</span>}
                  </label>
                  {isQdii
                    ? <span className="fund-confirm-hint" title="QDII（非国内）基金确认份额为 T+2，不受 15:00 前后影响；通常还需 T+2~T+3 才能卖出/到账。">
                        🌍 <b style={{ color: 'var(--accent)' }}>QDII 非国内基金</b>
                        <span style={{ marginLeft: 6, color: 'var(--muted)', fontSize: 12 }}>确认份额固定 T+2</span>
                        <br />📅 确认份额日期：<b style={{ color: 'var(--accent)' }}>{form.trans_date ? fundConfirmDate : '—'}</b>
                      </span>
                    : <span className="fund-confirm-hint" title="场外基金确认份额：15:00 前按当日净值，T+1 日确认份额；15:00 后按下一交易日净值，T+2 日确认份额（跳过周末，不含法定节假日）。若为非国内基金（QDII），请勾选上方选项。">
                        📅 确认份额日期：<b style={{ color: 'var(--accent)' }}>{form.trans_date ? fundConfirmDate : '—'}</b>
                        <span style={{ marginLeft: 6, color: 'var(--muted)', fontSize: 12 }}>（{fundRuleText}，T+{fundTPlus}，跳过周末）</span>
                      </span>}
                </div>
              </div>
            )}
            <div className="form-actions">
              <button className="btn-ghost" onClick={() => setShowForm(false)}>取消</button>
              <button className="btn" onClick={submit}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 编辑交易弹窗 */}
      {editTxn && (
        <div className="modal show" onClick={() => setEditTxn(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-head"><h3>编辑交易 #{editTxn.id}</h3><button className="modal-close" onClick={() => setEditTxn(null)}>×</button></div>
            <div className="form-row">
              <div><div className="form-label">市场</div>
                <select className="form-input" value={form.market} onChange={e => setForm({ ...form, market: e.target.value })}>
                  <option>A股</option><option>美股</option><option>港股</option><option>黄金</option><option>基金</option><option>债券</option>
                </select></div>
              <div><div className="form-label">代码</div><HistInput field="txn:code" value={form.code} onChange={v => setForm({ ...form, code: v })} placeholder="sh600519" /></div>
              <div><div className="form-label">方向</div>
                <select className="form-input" value={form.side} onChange={e => setForm({ ...form, side: e.target.value })}>
                  <option value="BUY">买入</option><option value="SELL">卖出</option>
                </select></div>
            </div>
            <div className="form-row">
              <div><div className="form-label">数量</div><HistInput field="txn:qty" type="number" value={form.quantity} onChange={v => setForm({ ...form, quantity: v })} /></div>
              <div><div className="form-label">价格</div><HistInput field="txn:price" type="number" value={form.price} onChange={v => setForm({ ...form, price: v })} /></div>
              <div><div className="form-label">手续费</div><HistInput field="txn:fee" type="number" value={form.fee} onChange={v => setForm({ ...form, fee: v })} /></div>
              <div><div className="form-label">日期</div><input className="form-input" type="date" value={form.trans_date} onChange={e => setForm({ ...form, trans_date: e.target.value })} /></div>
            </div>
            <div className="form-row"><div><div className="form-label">备注</div><input className="form-input" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /></div></div>
            {editTxn && editTxn.market === 'FUND' && (
              <div className="form-row" style={{ marginTop: 8 }}>
                <div style={{ alignSelf: 'flex-end', paddingBottom: 8 }}>
                  <label className="qdii-toggle" style={{ display: 'block', marginBottom: 6, cursor: 'pointer', fontSize: 13, color: 'var(--muted)' }}>
                    <input type="checkbox"
                      checked={isQdii}
                      onChange={e => setQdiiManual(e.target.checked)}
                      disabled={!!qdiiAuto}
                      style={{ marginRight: 5, cursor: 'pointer', verticalAlign: 'middle' }}
                    />
                    非国内基金（QDII，确认份额固定 T+2）
                    {qdiiAuto && <span style={{ color: 'var(--accent)', fontSize: 12, marginLeft: 4 }}>（已自动识别）</span>}
                  </label>
                  {isQdii
                    ? <span className="fund-confirm-hint" title="QDII（非国内）基金确认份额为 T+2，不受 15:00 前后影响。">
                        🌍 <b style={{ color: 'var(--accent)' }}>QDII 非国内基金</b>
                        <span style={{ marginLeft: 6, color: 'var(--muted)', fontSize: 12 }}>确认份额固定 T+2</span>
                        <br />📅 确认份额日期：<b style={{ color: 'var(--accent)' }}>{form.trans_date ? fundConfirmDate : '—'}</b>
                      </span>
                    : <span className="fund-confirm-hint" title="基金确认份额：15:00 前按当日净值 T+1 确认；15:00 后按下一交易日净值 T+2 确认（跳过周末，不含法定节假日）。若为非国内基金（QDII），请勾选上方选项。">
                        📅 确认份额日期：<b style={{ color: 'var(--accent)' }}>{form.trans_date ? fundConfirmDate : '—'}</b>
                        <span style={{ marginLeft: 6, color: 'var(--muted)', fontSize: 12 }}>（{fundRuleText}，T+{fundTPlus}，跳过周末）</span>
                      </span>}
                </div>
              </div>
            )}
            <div className="form-actions">
              <button className="btn-ghost" onClick={() => setEditTxn(null)}>取消</button>
              <button className="btn" onClick={saveEdit}>保存修改</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
