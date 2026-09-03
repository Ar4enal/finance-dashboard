import React, { useEffect, useRef } from 'react'
import * as echarts from 'echarts'

export default function EChart({ option, className = 'chart', style, onEvents, onChartReady }) {
  const ref = useRef(null)
  const chartRef = useRef(null)
  // 用 ref 持有最新 onEvents，避免重绑时闭包拿到旧值
  const eventsRef = useRef(onEvents)
  eventsRef.current = onEvents
  // 用 ref 持有最新 onChartReady，避免清理时闭包拿到旧值
  const readyRef = useRef(onChartReady)
  readyRef.current = onChartReady

  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current)
    chartRef.current = chart
    // 暴露实例给调用方（如 K 线需按图例选中态动态更新图标）
    if (readyRef.current) readyRef.current(chart)
    const onResize = () => chart.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.dispose()
      chartRef.current = null
      if (readyRef.current) readyRef.current(null)
    }
  }, [])

  // 绑定/重绑事件（option 变化或 onEvents 变化时）
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !onEvents) return
    const handlers = []
    Object.entries(onEvents).forEach(([evt, handler]) => {
      const h = (params) => eventsRef.current?.[evt]?.(params)
      chart.on(evt, h)
      handlers.push([evt, h])
    })
    return () => {
      handlers.forEach(([evt, h]) => chart.off(evt, h))
    }
  }, [onEvents, option])

  useEffect(() => {
    chartRef.current?.setOption(option, true)
  }, [option])

  return <div ref={ref} className={className} style={style} />
}
