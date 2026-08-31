/**
 * status-board — 悬浮状态看板 (v5 · OS 级浮动窗口)
 * 像桌宠弹窗那样：无边框、置顶、跨窗口悬浮（frame:false + alwaysOnTop，
 * 由 main 进程 setWindowOpenHandler 放行 ?win=plugin 窗口创建）。
 *
 * 交互：
 *  - 点击状态栏芯片 → 弹出 OS 浮动窗口（同名窗口复用，不重复弹）
 *  - 窗口内标题栏：按住左键拖动（OS 原生 -webkit-app-region: drag）
 *  - 窗口内右上角 ✕：关闭
 *  - 浮窗是完整 App renderer（自带 gateway + 插件系统），数据全走已有 RPC
 *
 * 数据策略（双代兼容）：
 *   - host.state.focusedUsage 存在（新 SDK）→ 实时流式原子，零 RPC
 *   - 否则回退 session.usage / session.context_breakdown RPC + 3s 轮询
 *   - 忙/闲由 message.start / message.complete 事件驱动
 *   - 模型/会话取自 host.state.model / host.state.activeSessionId
 */
import { host, ROUTES_AREA } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useState } from 'react'

const ID = 'status-board'
const ROUTE = '/board/status'
const WINDOW_NAME = 'status-board-overlay'
const BOARD_W = 316
const BOARD_H = 320
// 主窗口 → 浮窗 的会话桥：localStorage 同源共享（主窗口写，浮窗读）
const SB_SESSION_KEY = 'status-board.session-id'
const isOverlayWindow = () => new URLSearchParams(window.location.search).get('win') === 'plugin'

/* ── 赛博朋克色板 ── */
const C = {
  bgRoot: 'linear-gradient(155deg, #0d0420 0%, #1a0b3d 100%)',
  bgCell: '#160a30',
  border: '#00e5ff',
  borderDim: '#2a1a5e',
  neon: '#00e5ff',
  pink: '#ff2fa0',
  text: '#e8f6ff',
  muted: '#7dd3fc',
  dim: '#5b6b8a',
  good: '#00ff9d',
  warn: '#ffd166',
  danger: '#ff2f6d'
}

/* ── 工具 ── */

function fmt(n) {
  if (n == null) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}

function friendlyModel(m) {
  if (!m) return '—'
  const s = String(m).toLowerCase()
  if (s.includes('deepseek')) {
    const v = s.includes('v4') ? 'V4' : s.includes('v5') ? 'V5' : ''
    let tag = s.includes('flash') ? '闪速' : s.includes('pro') ? '旗舰' : ''
    if (s.includes('vision')) tag = tag ? tag + '·视觉' : '视觉'
    return `DeepSeek ${v} ${tag}`.replace(/\s+/g, ' ').trim()
  }
  const last = String(m).split('/').pop() || m
  return last.length > 22 ? last.slice(0, 22) + '…' : last
}

function overlayUrl() {
  const base = window.location.href.split('#')[0].split('?')[0]
  return `${base}?win=plugin#${ROUTE}`
}

function openOverlay() {
  const x = window.screenX + Math.max(0, window.outerWidth - BOARD_W - 24)
  const y = window.screenY + 64
  window.open(
    overlayUrl(),
    WINDOW_NAME,
    `width=${BOARD_W},height=${BOARD_H},left=${x},top=${y}`
  )
}

/** 安全订阅 atom：缺失该键时用 fallback，绝不崩（兼容旧 SDK）。 */
function useSafeAtom(name, fallback) {
  const atom = host.state[name]
  const [value, setValue] = useState(atom ? atom.get() : fallback)
  useEffect(() => {
    if (!atom) { setValue(fallback); return }
    setValue(atom.get())
    const un = atom.listen ? atom.listen(v => setValue(v)) : null
    return () => { if (un) un() }
  }, [name])
  return value
}

/** 忙/闲：message.start → busy；message.complete → idle。 */
function useTurnActivity() {
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const offs = []
    try {
      const o1 = host.onEvent('message.start', () => setBusy(true))
      const o2 = host.onEvent('message.complete', () => setBusy(false))
      if (o1) offs.push(o1)
      if (o2) offs.push(o2)
    } catch (e) { /* 老版本事件名差异——忽略 */ }
    return () => offs.forEach(o => { try { o() } catch (e) { /* noop */ } })
  }, [])
  return busy
}

/** 用量：新版用 focusedUsage 实时原子；旧版轮询 session.usage。 */
function useUsage(sessionId) {
  const live = useSafeAtom('focusedUsage', null)
  const [rpc, setRpc] = useState(null)
  const fetchRpc = useCallback(() => {
    if (!sessionId) return
    host.request('session.usage', { session_id: sessionId })
      .then(u => setRpc(u || null))
      .catch(() => undefined)
  }, [sessionId])

  useEffect(() => { fetchRpc() }, [fetchRpc])
  useEffect(() => {
    if (live != null) return
    const t = setInterval(fetchRpc, 3000)
    return () => clearInterval(t)
  }, [live, fetchRpc])
  useEffect(() => {
    if (!sessionId || live != null) return
    let off = null
    try { off = host.onEvent('message.complete', fetchRpc) } catch (e) { /* noop */ }
    return () => { if (off) { try { off() } catch (e) { /* noop */ } } }
  }, [sessionId, live, fetchRpc])

  return live || rpc
}

/** 上下文明细：session.context_breakdown（两代均有该 RPC）。 */
function useBreakdown(sessionId) {
  const [breakdown, setBreakdown] = useState(null)
  const fetchBd = useCallback(() => {
    if (!sessionId) return
    host.request('session.context_breakdown', { session_id: sessionId })
      .then(b => setBreakdown(b || null))
      .catch(() => undefined)
  }, [sessionId])

  useEffect(() => { fetchBd() }, [fetchBd])
  useEffect(() => {
    if (!sessionId) return
    let off = null
    try { off = host.onEvent('message.complete', fetchBd) } catch (e) { /* noop */ }
    return () => { if (off) { try { off() } catch (e) { /* noop */ } } }
  }, [sessionId, fetchBd])

  return breakdown
}

/** 聚焦会话：主窗口 = 本地 activeSessionId（写入存储供浮窗读）；
 *  浮窗窗口 = 读主窗口写入的会话 id（2s 兜底轮询 + storage 事件）。 */
function useFocusedSessionId() {
  const local = useSafeAtom('activeSessionId', null)
  const overlay = isOverlayWindow()
  const [remote, setRemote] = useState(() => {
    try { return localStorage.getItem(SB_SESSION_KEY) } catch (e) { return null }
  })

  useEffect(() => {
    if (overlay) {
      const read = () => {
        try { setRemote(localStorage.getItem(SB_SESSION_KEY)) } catch (e) { /* noop */ }
      }
      read()
      const t = setInterval(read, 2000)
      window.addEventListener('storage', read)
      return () => { clearInterval(t); window.removeEventListener('storage', read) }
    }
    return undefined
  }, [overlay])

  useEffect(() => {
    if (overlay) return
    try {
      if (local) localStorage.setItem(SB_SESSION_KEY, local)
    } catch (e) { /* noop */ }
  }, [overlay, local])

  return overlay ? remote : local
}

/* ── 看板页面（浮窗窗口里渲染） ── */

function StatusBoardPage() {
  const model = useSafeAtom('model', '')
  const sessionId = useFocusedSessionId()
  const busy = useTurnActivity()
  const usage = useUsage(sessionId)
  const breakdown = useBreakdown(sessionId)

  const calls = usage?.calls ?? 0
  const input = usage?.input ?? 0
  const output = usage?.output ?? 0
  const total = usage?.total ?? (input + output)
  const cost = usage?.cost_usd
  const cacheRead = usage?.cache_read
  const cacheWrite = usage?.cache_write
  const ctxMax = breakdown?.context_max ?? usage?.context_max ?? 0
  const ctxUsed = breakdown?.context_used ?? usage?.context_used ?? 0
  const ctxPct = breakdown?.context_percent ?? usage?.context_percent
    ?? (ctxMax ? Math.round((ctxUsed / ctxMax) * 100) : 0)
  const remaining = ctxMax ? Math.max(0, ctxMax - ctxUsed) : null
  const clampPct = Math.max(0, Math.min(100, Math.round(ctxPct)))
  const barColor = clampPct > 80 ? C.danger : clampPct > 60 ? C.warn : C.neon

  const tokenRows = [
    ['输入', fmt(input)],
    ['输出', fmt(output)],
    ['总计', fmt(total)],
    ['调用', calls]
  ]

  return jsxs('div', {
    style: {
      width: '100vw', height: '100vh', overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      background: C.bgRoot, border: `1px solid ${C.border}`, borderRadius: 10,
      boxSizing: 'border-box',
      fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
      color: C.text, fontSize: 12
    },
    children: [
      // 标题栏：-webkit-app-region: drag = OS 原生按住左键拖动
      jsxs('div', {
        className: 'flex items-center justify-between gap-2 px-3 py-2',
        style: {
          borderBottom: `1px solid ${C.borderDim}`,
          WebkitAppRegion: 'drag',
          cursor: 'grab',
          flex: 'none'
        },
        children: [
          jsxs('div', { className: 'flex min-w-0 items-center gap-1.5', children: [
            jsx('span', { className: 'size-2 rounded-full', style: { background: busy ? C.neon : C.good, boxShadow: `0 0 6px ${busy ? C.neon : C.good}` } }),
            jsx('span', { style: { color: C.neon, fontWeight: 700, letterSpacing: 1 }, children: '状态看板' }),
            jsx('span', { style: { color: C.pink, fontFamily: 'Consolas, monospace', fontSize: 9, letterSpacing: 2 }, children: 'SYS.MONITOR' })
          ]}),
          jsx('button', {
            type: 'button',
            'aria-label': '关闭看板',
            style: {
              WebkitAppRegion: 'no-drag', background: 'transparent', border: 'none',
              color: C.pink, fontSize: 13, cursor: 'pointer', padding: '2px 4px', lineHeight: 1
            },
            onClick: () => window.close(),
            children: '✕'
          })
        ]
      }),
      // 内容区
      jsxs('div', {
        className: 'flex flex-col gap-2.5 overflow-auto p-3',
        style: { flex: 1, WebkitAppRegion: 'no-drag' },
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between gap-2',
            children: [
              jsxs('span', { className: 'flex items-center gap-1.5', children: [
                jsx('span', { style: { color: C.muted, border: `1px solid ${C.borderDim}`, borderRadius: 4, padding: '1px 6px', fontSize: 10 }, children: `${calls} 次调用` }),
                cost != null ? jsx('span', { style: { color: C.muted, border: `1px solid ${C.borderDim}`, borderRadius: 4, padding: '1px 6px', fontSize: 10 }, children: `$${Number(cost).toFixed(3)}` }) : null
              ]}),
              jsx('span', { style: { color: C.dim, fontSize: 10 }, children: sessionId ? `会话 ${sessionId.slice(0, 12)}` : '无会话' })
            ]
          }),
          jsxs('div', { className: 'flex flex-col gap-1', children: [
            jsx('span', { style: { color: C.muted, fontSize: 10 }, children: '当前模型' }),
            jsx('span', { style: { color: C.text, fontWeight: 700, fontSize: 13 }, children: friendlyModel(model) })
          ]}),
          jsx('div', { className: 'grid grid-cols-4 gap-1.5', children: tokenRows.map(([label, v]) =>
            jsxs('div', {
              className: 'flex flex-col rounded-md px-2 py-1.5',
              style: { background: C.bgCell, border: `1px solid ${C.borderDim}` },
              children: [
                jsx('span', { style: { color: C.muted, fontSize: 10 }, children: label }),
                jsx('span', { style: { color: C.good, fontWeight: 700, fontFamily: 'Consolas, monospace', fontSize: 13 }, children: v })
              ]
            })
          )}),
          jsxs('div', {
            className: 'flex items-center justify-between rounded-md px-2 py-1.5',
            style: { background: C.bgCell, border: `1px solid ${C.borderDim}` },
            children: [
              jsx('span', { style: { color: C.muted, fontSize: 10 }, children: '缓存命中' }),
              jsxs('span', { style: { color: (cacheRead ?? 0) > 0 ? C.neon : C.dim, fontWeight: 700, fontFamily: 'Consolas, monospace', fontSize: 12 }, children: [
                cacheRead != null ? fmt(cacheRead) : '—',
                cacheWrite != null ? jsx('span', { style: { color: C.dim, fontWeight: 400, fontSize: 9 }, children: ` · 写入 ${fmt(cacheWrite)}` }) : null
              ]})
            ]
          }),
          jsxs('div', { className: 'flex flex-col gap-1.5', children: [
            jsxs('div', { className: 'flex items-center justify-between gap-2', children: [
              jsx('span', { style: { color: C.muted, fontSize: 10 }, children: '上下文' }),
              jsxs('span', { style: { color: C.text, fontSize: 10, fontFamily: 'Consolas, monospace' }, children: [
                remaining != null
                  ? `${fmt(ctxUsed)} / ${fmt(ctxMax)} · 剩 ${fmt(remaining)} · ${clampPct}%`
                  : '暂无测量'
              ]})
            ]}),
            jsx('div', {
              className: 'h-1.5 w-full overflow-hidden rounded-full',
              style: { background: C.bgCell, border: `1px solid ${C.borderDim}` },
              children: jsx('div', {
                className: 'h-full rounded-full transition-all',
                style: { width: `${clampPct}%`, background: barColor, boxShadow: `0 0 8px ${barColor}` }
              })
            })
          ]}),
          jsx('div', { className: 'flex flex-col gap-1.5', children: [
            (breakdown?.categories && breakdown.categories.length)
              ? jsxs('ul', { className: 'flex flex-col gap-1', children: breakdown.categories.map(cat =>
                  jsxs('li', {
                    className: 'flex items-center justify-between gap-2',
                    style: { fontSize: 10 },
                    children: [
                      jsxs('span', { className: 'flex min-w-0 items-center gap-1.5', children: [
                        jsx('span', { className: 'size-2 shrink-0 rounded-[2px]', style: { background: cat.color } }),
                        jsx('span', { className: 'truncate', style: { color: C.muted }, children: cat.label })
                      ]}),
                      jsx('span', { style: { color: C.text, fontFamily: 'Consolas, monospace' }, children: fmt(cat.tokens) })
                    ]
                  })
                )})
              : jsx('span', { style: { color: C.dim, fontSize: 10 }, children: '无上下文明细' })
          ]}),
          jsx('div', { className: 'flex items-center justify-between pt-0.5', children: [
            jsx('button', {
              type: 'button',
              onClick: () => {
                if (sessionId) {
                  host.request('session.usage', { session_id: sessionId }).catch(() => undefined)
                  host.request('session.context_breakdown', { session_id: sessionId }).catch(() => undefined)
                }
              },
              style: { background: 'transparent', border: `1px solid ${C.neon}`, color: C.neon, borderRadius: 4, fontSize: 10, padding: '2px 10px', cursor: 'pointer', boxShadow: '0 0 8px rgba(0,229,255,0.25)' },
              children: '刷新'
            }),
            jsx('span', { style: { color: C.dim, fontSize: 9 }, children: '按住标题栏拖动' })
          ]})
        ]
      })
    ]
  })
}

/** 状态栏芯片：点击弹出 OS 浮动窗口。 */
function BoardChip() {
  const model = useSafeAtom('model', '')
  const sessionId = useFocusedSessionId()
  const busy = useTurnActivity()
  const usage = useUsage(sessionId)
  const ctxPct = usage?.context_percent
    ?? (usage?.context_max ? Math.round(((usage?.context_used ?? 0) / usage.context_max) * 100) : null)

  return jsx('button', {
    type: 'button',
    style: { background: 'transparent', border: 'none', cursor: 'pointer', color: C.muted, fontSize: 10, padding: '0 6px', height: '100%', display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'Consolas, monospace' },
    title: '打开悬浮状态看板（跨窗口）',
    onClick: openOverlay,
    children: jsxs('span', { className: 'inline-flex items-center gap-1', children: [
      jsx('span', { className: 'size-1.5 rounded-full', style: { background: busy ? C.neon : C.good } }),
      jsx('span', { children: friendlyModel(model) }),
      jsx('span', { style: { opacity: 0.55 }, children: '·' }),
      jsx('span', { children: usage ? fmt(usage.total) : '0 token' }),
      jsx('span', { style: { opacity: 0.55 }, children: '·' }),
      jsx('span', { children: ctxPct != null ? '上下文 ' + ctxPct + '%' : '上下文 —' })
    ]})
  })
}

export default {
  id: ID,
  name: '状态看板',
  register(ctx) {
    // 浮窗路由页：OS 浮动窗口加载 ?win=plugin#/board/status 时渲染
    ctx.register({
      id: 'overlay-page',
      area: ROUTES_AREA,
      data: { path: ROUTE },
      render: () => jsx(StatusBoardPage, {})
    })
    // 状态栏芯片：打开/聚焦浮窗
    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 100,
      render: () => jsx(BoardChip, {})
    })
  }
}
