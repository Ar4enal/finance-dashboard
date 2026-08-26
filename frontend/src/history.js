// 输入框历史记忆：基于 localStorage，记忆每个字段最近 5 个去重输入值。
// 纯前端实现，不依赖后端，随浏览器本地保存（不跨机器迁移）。
import { useState, useRef, useEffect } from 'react'

const PREFIX = 'fwt:hist:'   // finance workbench history
const MAX = 5

function keyOf(field) { return PREFIX + field }

export function loadHistory(field) {
  try {
    const raw = localStorage.getItem(keyOf(field))
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

export function pushHistory(field, value) {
  const v = (value ?? '').toString().trim()
  if (!v) return
  let arr = loadHistory(field).filter(x => x !== v)
  arr.unshift(v)
  arr = arr.slice(0, MAX)
  try { localStorage.setItem(keyOf(field), JSON.stringify(arr)) } catch {}
}

export function clearHistory(field, value) {
  const arr = loadHistory(field).filter(x => x !== value)
  try { localStorage.setItem(keyOf(field), JSON.stringify(arr)) } catch {}
}

// 受控输入框 + 历史记忆下拉
export function useInputHistory(field, value, onChange) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState(loadHistory(field))
  const wrapRef = useRef(null)

  useEffect(() => {
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const commit = (val) => {
    onChange(val)
    pushHistory(field, val)
    setList(loadHistory(field))
    setOpen(false)
  }

  const onBlur = (e) => {
    // 延迟以便点击候选项能先触发
    setTimeout(() => {
      pushHistory(field, e.target.value)
      setList(loadHistory(field))
    }, 150)
  }

  return {
    wrapRef,
    open,
    list,
    setOpen,
    commit,
    onBlur,
  }
}
