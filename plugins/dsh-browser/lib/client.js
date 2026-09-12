window.__ModuleLoader__.load({ id: 'dsh-browser', factory: (require) => {
  'use strict'
  var module = { exports: {} }
  var exports = module.exports
  const React = require('react')

// dsh-browser client half: OUR browser tab. A same-origin sidebar tab with an
// address bar and a sandboxed iframe, driven by the agent's `browser` tool
// (open/navigate/focus/screenshot) and by the human's own address bar. It
// replaces the dsh-better-sidebar builtin browser (hidden from the + menu).
// The visited page is cross-origin sandboxed, so neither side can script it;
// for the workspace prototype use dsh-prototype's full-control automation.

const TAB_ID = 'dsh-browser:view'
const DEFAULT_URL = 'https://example.com'

// Shared with the command poller: the last URL the agent asked for, and the
// mounted view's setter so a navigate can reach a tab that is already open.
let desiredUrl = null
let setUrlFromAgent = null

function api(method, payload) {
  return fetch('/browser/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  }).then((r) => r.json())
}

// Capture the app window through the desktop bridge: no gesture, no picker.
function captureWindow() {
  const bridge = window.dshDesktopScreenCapture
  if (bridge && typeof bridge.capture === 'function') return bridge.capture()
  return Promise.reject(new Error('screenshots require the DSH Desktop app'))
}

/** Add https:// to a bare host; refuse non-http(s) input. */
function normalize(input) {
  const trimmed = String(input ?? '').trim()
  if (trimmed === '') return null
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.href
  } catch { return null }
}

function injectStyles() {
  const id = 'db-styles'
  if (document.getElementById(id)) return
  const el = document.createElement('style')
  el.id = id
  el.textContent = `
.db-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#e8e8ea);font-size:13px;font-family:inherit}
.db-bar{display:flex;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#3a3b44);flex:none}
.db-input{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-1,#26272e);color:inherit;border:1px solid var(--dsw-alias-border-l2,#4a4b55);border-radius:6px;padding:4px 8px;font-size:12px;outline:none;font-family:inherit}
.db-btn{display:inline-flex;align-items:center;gap:5px;background:var(--dsw-alias-bg-layer-2,#31323b);color:var(--dsw-alias-label-primary,#e8e8ea);border:1px solid var(--dsw-alias-border-l2,#4a4b55);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;white-space:nowrap;font-family:inherit}
.db-btn:hover{background:var(--dsw-specific-sidebar-nav-item-hover,var(--dsw-alias-bg-layer-2,#3a3b46))}
.db-frame{flex:1;width:100%;border:none;display:block;background:#fff;min-height:0}
.db-hint{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#7c7c88);font-size:12px;padding:20px;text-align:center}
`
  document.head.appendChild(el)
}

function BrowserTab() {
  const h = React.createElement
  const [url, setUrl] = React.useState(desiredUrl || DEFAULT_URL)
  const [input, setInput] = React.useState(desiredUrl || DEFAULT_URL)
  const [key, setKey] = React.useState(0)
  const [bad, setBad] = React.useState(false)

  const show = React.useCallback((next) => {
    setUrl(next)
    setInput(next)
    setKey((k) => k + 1)
  }, [])

  React.useEffect(() => {
    setUrlFromAgent = show
    if (desiredUrl && desiredUrl !== url) show(desiredUrl)
    return () => { if (setUrlFromAgent === show) setUrlFromAgent = null }
  }, [show, url])

  const go = () => {
    const next = normalize(input)
    if (!next) { setBad(true); return }
    setBad(false)
    desiredUrl = next
    show(next)
  }

  return h('div', { className: 'db-root' },
    h('div', { className: 'db-bar' },
      h('input', {
        className: 'db-input', value: input, spellCheck: false, placeholder: 'https://…',
        onChange: (e) => setInput(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') go() },
      }),
      h('button', { className: 'db-btn', onClick: go }, 'Ir'),
      h('button', { className: 'db-btn', onClick: () => setKey((k) => k + 1), title: 'Recarregar' }, '⟳')),
    bad ? h('div', { className: 'db-hint' }, 'Endereço inválido — use http(s).') : null,
    h('iframe', {
      key, className: 'db-frame', src: url, title: 'browser',
      sandbox: 'allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox',
    }))
}

function Icon(size) {
  return React.createElement('svg', {
    width: size || 16, height: size || 16, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
  },
    React.createElement('circle', { cx: 8, cy: 8, r: 6 }),
    React.createElement('path', { d: 'M2 8h12M8 2c1.8 2 1.8 10 0 12M8 2c-1.8 2-1.8 10 0 12' }),
  )
}

function apply(ctx) {
  injectStyles()
  ctx.plugin({
    inject: ['betterSidebar'],
    apply(sidebarCtx) {
      const betterSidebar = sidebarCtx.betterSidebar
      if (!betterSidebar || typeof betterSidebar.registerTab !== 'function') return
      if (!(window.__profileTabEnabled || (() => true))(TAB_ID)) return
      const scope = () => {
        const sid = betterSidebar.getSnapshot?.()?.sessionId
        return typeof sid === 'string' && sid ? { sessionId: sid } : undefined
      }
      const openOurTab = () => {
        if (typeof betterSidebar.openTab === 'function') betterSidebar.openTab({ type: TAB_ID }, scope())
      }
      ctx.effect(() => betterSidebar.registerTab({
        id: TAB_ID,
        title: 'Browser',
        order: 51,
        single: true,
        icon: (size) => Icon(size),
        component: (props) => React.createElement(BrowserTab, props),
      }))
      // Poll the agent's commands and drive the tab.
      ctx.effect(() => {
        let alive = true
        let timer = null
        const tick = async () => {
          try {
            const r = await api('pending', {})
            const cmd = r?.cmd
            if (alive && cmd) {
              if (cmd.op === 'screenshot') {
                openOurTab()
                await new Promise((res) => setTimeout(res, 600))
                try {
                  const dataUrl = await captureWindow()
                  await api('result', { id: cmd.id, ok: true, dataUrl })
                } catch (e) {
                  await api('result', { id: cmd.id, ok: false, error: String((e && e.message) || e) })
                }
              } else if (cmd.op === 'navigate' || cmd.op === 'open') {
                const next = normalize(cmd.url)
                if (next) { desiredUrl = next; if (setUrlFromAgent) setUrlFromAgent(next) }
                openOurTab()
                await api('result', { id: cmd.id, ok: true, url: next ?? null })
              } else {
                openOurTab()
                await api('result', { id: cmd.id, ok: true })
              }
            }
          } catch { /* offline */ }
          if (alive) timer = setTimeout(tick, 700)
        }
        tick()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, 'dsh-browser: command poll')
    },
  })
}

  exports.apply = apply
  return module.exports
} })
