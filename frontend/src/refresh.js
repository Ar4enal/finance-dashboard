import React from 'react'

// 自动刷新频率选项（秒）
export const REFRESH_OPTIONS = [5, 10, 30, 60]
export const DEFAULT_REFRESH_SEC = 30
const STORAGE_KEY = 'fw_refresh_sec'

// 全局刷新频率上下文：页面轮询间隔统一从这里取，切换时实时生效
export const RefreshContext = React.createContext(DEFAULT_REFRESH_SEC)

export function loadRefreshSec() {
  try {
    const v = parseInt(localStorage.getItem(STORAGE_KEY), 10)
    return REFRESH_OPTIONS.includes(v) ? v : DEFAULT_REFRESH_SEC
  } catch (e) {
    return DEFAULT_REFRESH_SEC
  }
}

export function saveRefreshSec(sec) {
  try {
    localStorage.setItem(STORAGE_KEY, String(sec))
  } catch (e) {}
}
