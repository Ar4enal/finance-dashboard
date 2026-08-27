// API 封装
const BASE = ''

async function request(path, options = {}) {
  const res = await fetch(BASE + path, options)
  const data = await res.json()
  if (data.code !== 0) throw new Error(data.msg || '请求失败')
  return data.data
}

export const api = {
  // 行情
  quotes: (market, code) => request(`/api/quotes?market=${market}&code=${code}`),
  batchQuotes: (items) => request(`/api/quotes/batch?items=${items}`),
  kline: (market, code, count = 120) => request(`/api/kline?market=${market}&code=${code}&count=${count}`),
  // 基金
  fundDetail: (code) => request(`/api/fund/detail?code=${code}`),
  fundPenetrate: (code) => request(`/api/fund/penetrate?code=${code}`),
  fundPenetrationHoldings: () => request('/api/fund/penetration/holdings'),
  fundQdiiCheck: (code) => request(`/api/fund/qdii/check?code=${encodeURIComponent(code)}`),
  // 基金确认份额日期（跳过周末与官方休市日）：qdii=是否非国内基金，time=before/after(15:00前后)
  fundConfirmDate: (transDate, qdii, time) => request(`/api/fund/confirm-date?trans_date=${encodeURIComponent(transDate)}&qdii=${!!qdii}&time=${time || 'before'}`),
  // 自选
  watchlist: () => request('/api/watchlist'),
  addWatch: (market, code, name) => request(`/api/watchlist?market=${market}&code=${code}${name ? '&name=' + encodeURIComponent(name) : ''}`, { method: 'POST' }),
  delWatch: (id) => request(`/api/watchlist/${id}`, { method: 'DELETE' }),
  // 行情看板指数配置（自定义选择/新增/删除/移动）
  indices: () => request('/api/indices'),
  addIndex: (name, market, code) => request(`/api/indices?name=${encodeURIComponent(name)}&market=${market}&code=${encodeURIComponent(code)}`, { method: 'POST' }),
  delIndex: (id) => request(`/api/indices/${id}`, { method: 'DELETE' }),
  moveIndex: (id, dir) => request(`/api/indices/${id}/move?dir=${dir}`, { method: 'POST' }),
  // A股板块资金流向（当天前十流入/流出）
  sectorFlow: () => request('/api/quotes/sector-flow'),
  // 持仓置顶
  positionPins: () => request('/api/position/pins'),
  pinPosition: (market, code) => request(`/api/position/pin?market=${market}&code=${encodeURIComponent(code)}`, { method: 'POST' }),
  unpinPosition: (market, code) => request(`/api/position/pin/${market}/${encodeURIComponent(code)}`, { method: 'DELETE' }),
  // 交易
  transactions: (market, code) => request(`/api/transactions${market ? '?market=' + market : ''}`),
  addTxn: (t) => request(`/api/transactions?market=${t.market}&code=${t.code}&side=${t.side}&quantity=${t.quantity}&price=${t.price}&fee=${t.fee||0}&trans_date=${t.trans_date}&note=${t.note||''}`, { method: 'POST' }),
  updateTxn: (id, fields) => {
    const q = Object.entries(fields).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    return request(`/api/transactions/${id}?${q}`, { method: 'PUT' })
  },
  delTxn: (id) => request(`/api/transactions/${id}`, { method: 'DELETE' }),
  // 持仓/组合
  positions: () => request('/api/positions'),
  portfolioSummary: () => request('/api/portfolio/summary'),
  portfolioAllocation: (by) => request(`/api/portfolio/allocation?by=${by}`),
  // 组合净值曲线（每日快照）：period=all|30|90
  portfolioPerformance: (period = 'all') => request(`/api/portfolio/performance?period=${period}`),
  // 收益分析：type=day|month|year|cum，range=YYYY-MM-DD|YYYY-MM|YYYY（cum 忽略）
  pnlAnalysis: (type, range) => request(`/api/portfolio/pnl-analysis?type=${type}${range ? '&range=' + encodeURIComponent(range) : ''}`),
  // 资产收益编辑（过滤未传参数，避免 undefined 拼进 URL）
  saveProfit: (market, code, holding, cum) => {
    const params = new URLSearchParams()
    params.set('market', market); params.set('code', code)
    if (holding != null && !isNaN(holding)) params.set('holding', holding)
    if (cum != null && !isNaN(cum)) params.set('cum', cum)
    return request(`/api/profit?${params.toString()}`, { method: 'POST' })
  },
  clearProfit: (market, code, which) => request(`/api/profit?market=${market}&code=${code}&clear=${which}`, { method: 'POST' }),
  // 持仓覆盖（编辑数量/成本、删除持仓）
  savePositionOverride: (market, code, quantity, cost) => request(`/api/position/override?market=${market}&code=${encodeURIComponent(code)}&quantity=${quantity}&cost=${cost}`, { method: 'POST' }),
  deletePosition: (market, code) => request(`/api/position/${market}/${encodeURIComponent(code)}`, { method: 'DELETE' }),
  // 新增初始持仓（直接录入，不用通过交易）：market/code/amount(持有金额)/pnl(持有收益)
  addManualPosition: (market, code, amount, pnl) => request(`/api/position/manual?market=${market}&code=${encodeURIComponent(code)}&amount=${amount}&pnl=${pnl || 0}`, { method: 'POST' }),
  // 批量导入初始持仓：items = [{market, code, amount, pnl}, ...]，返回 {total, success, failed, results}
  addManualPositionBatch: (items) => request('/api/position/manual/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(items) }),
  // 实物黄金
  gold: () => request('/api/gold'),
  saveGold: (grams, cost_price) => request(`/api/gold/save?grams=${grams}&cost_price=${cost_price}`, { method: 'POST' }),
  delGold: () => request('/api/gold', { method: 'DELETE' }),
  // 实物黄金交易流水（买入/卖出录入，按加权平均成本更新持仓与收益）
  goldTxns: () => request('/api/gold/transactions'),
  addGoldTxn: (side, grams, price, trans_date, note) => request(`/api/gold/transactions?side=${side}&grams=${grams}&price=${price}&trans_date=${trans_date}${note ? '&note=' + encodeURIComponent(note) : ''}`, { method: 'POST' }),
  delGoldTxn: (id) => request(`/api/gold/transactions/${id}`, { method: 'DELETE' }),
  // 数据导入导出（跨机器迁移持仓等全部用户数据）
  dataExportInfo: () => request('/api/data/export/info'),
  dataImport: () => request('/api/data/import', { method: 'POST' }),
  // 导出：触发浏览器下载项目根目录生成的 JSON 备份文件
  dataExportDownload: () => {
    const a = document.createElement('a')
    a.href = '/api/data/export'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  },
  // 资讯
  news: (keyword) => request(`/api/news${keyword ? '?keyword=' + keyword : ''}`),
}
