import React, { useState, useEffect } from 'react'
import EChart from './EChart.jsx'
import { api } from '../api.js'

export default function KlineChart({ market, code }) {
  const [kdata, setKdata] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!market || !code) return
    setKdata(null)
    setError('')
    api.kline(market, code, 120)
      .then(setKdata)
      .catch(e => setError(e.message))
  }, [market, code])

  if (error) return <div className="empty" style={{ padding: 30, textAlign: 'center' }}>📭 {error}</div>
  if (!kdata) return <div className="loading">加载K线中...</div>

  const { dates, ohlc, volume, ma5, ma10, ma20, macdDIF, macdDEA, macdBAR, proxied, proxy_note } = kdata

  const option = {
    animation: false,
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    // 三个面板的图表名称标签（左上角）
    graphic: [
      { type: 'text', left: 8, top: 38, style: { text: 'K线 · MA', fill: '#8b949e', fontSize: 12, fontWeight: 'bold' } },
      { type: 'text', left: 8, top: '59%', style: { text: '成交量', fill: '#8b949e', fontSize: 12, fontWeight: 'bold' } },
      { type: 'text', left: 8, top: '79%', style: { text: 'MACD', fill: '#8b949e', fontSize: 12, fontWeight: 'bold' } },
    ],
    legend: {
      data: ['K线', 'MA5', 'MA10', 'MA20', '成交量', 'DIF', 'DEA', 'MACD'],
      textStyle: { color: '#8b949e' }, top: 0, type: 'scroll', itemWidth: 14,
    },
    // 三个独立面板：K线(0) | 成交量(1) | MACD(2)，高度/间距统一用百分比，避免重叠
    grid: [
      { left: 64, right: 20, top: 30, height: '52%', containLabel: false },
      { left: 64, right: 20, top: '62%', height: '15%', containLabel: false },
      { left: 64, right: 20, top: '82%', height: '15%', containLabel: false },
    ],
    xAxis: [
      { type: 'category', gridIndex: 0, data: dates, axisLabel: { color: '#8b949e' }, axisLine: { lineStyle: { color: '#2a3040' } } },
      { type: 'category', gridIndex: 1, data: dates, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#2a3040' } } },
      { type: 'category', gridIndex: 2, data: dates, axisLabel: { color: '#8b949e' }, axisLine: { lineStyle: { color: '#2a3040' } } },
    ],
    yAxis: [
      { gridIndex: 0, scale: true, axisLabel: { color: '#8b949e' }, splitLine: { lineStyle: { color: 'rgba(42,48,64,.4)' } } },
      { gridIndex: 1, scale: true, axisLabel: { color: '#8b949e', formatter: v => v >= 1e8 ? (v/1e8).toFixed(1) + '亿' : v >= 1e4 ? (v/1e4).toFixed(0) + '万' : v }, splitLine: { lineStyle: { color: 'rgba(42,48,64,.4)' } } },
      { gridIndex: 2, scale: true, axisLabel: { color: '#8b949e' }, splitLine: { lineStyle: { color: 'rgba(42,48,64,.4)' } } },
    ],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1, 2], start: 40, end: 100 }],
    series: [
      // --- 面板 0：K线 + MA（统一红涨绿跌：阳线=红 #f85149，阴线=绿 #3fb950）---
      {
        name: 'K线', type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0, data: ohlc,
        itemStyle: { color: '#f85149', color0: '#3fb950', borderColor: '#f85149', borderColor0: '#3fb950' },
      },
      { name: 'MA5', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma5, symbol: 'none', lineStyle: { color: '#d29922', width: 1 } },
      { name: 'MA10', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma10, symbol: 'none', lineStyle: { color: '#58a6ff', width: 1 } },
      { name: 'MA20', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma20, symbol: 'none', lineStyle: { color: '#a371f7', width: 1 } },
      // --- 面板 1：成交量（独立，与K线分开；上涨=红，下跌=绿）---
      {
        name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: volume,
        barWidth: '60%',
        itemStyle: { color: (p) => ohlc[p.dataIndex][0] <= ohlc[p.dataIndex][1] ? 'rgba(248,81,73,.7)' : 'rgba(63,185,80,.7)' },
      },
      // --- 面板 2：MACD（红涨绿跌：柱值>=0 为红，<0 为绿）---
      { name: 'DIF', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: macdDIF, symbol: 'none', lineStyle: { color: '#58a6ff', width: 1 } },
      { name: 'DEA', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: macdDEA, symbol: 'none', lineStyle: { color: '#d29922', width: 1 } },
      {
        name: 'MACD', type: 'bar', xAxisIndex: 2, yAxisIndex: 2, data: macdBAR,
        barWidth: '50%',
        itemStyle: { color: (p) => p.value >= 0 ? '#f85149' : '#3fb950' },
      },
    ],
  }

  return (
    <>
      {proxied && proxy_note && (
        <div className="kline-proxy-note">⚠️ {proxy_note}</div>
      )}
      <EChart option={option} className="chart-md" style={{ height: 660 }} />
    </>
  )
}
