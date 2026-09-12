window.__ModuleLoader__.load({ id: 'dsh-browser', factory: (require) => {
  'use strict'
  var module = { exports: {} }
  var exports = module.exports

// dsh-browser client half: owns the browser tab and the window capture for the
// agent's `browser` tool. It polls the host for one command at a time, opens or
// focuses the better-sidebar browser tab, and captures the app window for
// screenshots. It registers no tab of its own.

const BROWSER_TAB = 'browser'

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

function apply(ctx) {
  ctx.plugin({
    inject: ['betterSidebar'],
    apply(sidebarCtx) {
      const betterSidebar = sidebarCtx.betterSidebar
      if (!betterSidebar || typeof betterSidebar.openTab !== 'function') return
      const scope = () => {
        const sid = betterSidebar.getSnapshot?.()?.sessionId
        return typeof sid === 'string' && sid ? { sessionId: sid } : undefined
      }
      const focusBrowser = (url) => {
        const seed = { type: BROWSER_TAB }
        if (typeof url === 'string' && url) seed.url = url
        betterSidebar.openTab(seed, scope())
      }
      ctx.effect(() => {
        let alive = true
        let timer = null
        const tick = async () => {
          try {
            const r = await api('pending', {})
            const cmd = r?.cmd
            if (alive && cmd) {
              if (cmd.op === 'screenshot') {
                focusBrowser()
                // Give the just-focused tab a beat to paint before the grab.
                await new Promise((res) => setTimeout(res, 600))
                try {
                  const dataUrl = await captureWindow()
                  await api('result', { id: cmd.id, ok: true, dataUrl })
                } catch (e) {
                  await api('result', { id: cmd.id, ok: false, error: String((e && e.message) || e) })
                }
              } else {
                focusBrowser(cmd.url)
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
