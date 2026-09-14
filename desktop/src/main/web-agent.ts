import { BrowserWindow, WebContentsView, ipcMain, type IpcMainInvokeEvent } from 'electron'

/**
 * Full-scope browser automation for the agent. One dedicated WebContentsView
 * is embedded INSIDE the main window, over the Browser tab's content area, so
 * the human watches the agent drive a real page (click, fill, read, eval,
 * console, wait) — cross-origin included, because the executor is the main
 * process. The sandboxed iframe of the workspace prototype stays untouched;
 * this view only mounts while a full-scope navigation is active.
 *
 * The view owns an isolated in-memory session (partition), so cookies from
 * automation logins never mix with the app's own session and die with the app.
 * Fill values are never logged here: results carry only shape, never content.
 */

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface RunPayload {
  op: string
  selector?: string
  text?: string
  value?: string
  code?: string
  attr?: string
  timeoutMs?: number
  ms?: number
}

type RunResult = { ok: true; data: unknown } | { ok: false; error: string }

const CONSOLE_RING_MAX = 200
const VIEW_PARTITION = 'dsh-web-agent'
const FIND_INTERVAL_MS = 150
const DEFAULT_WAIT_MS = 8000
const MAX_WAIT_MS = 30000

let view: WebContentsView | null = null
let hostWindow: BrowserWindow | null = null
let consoleRing: Array<{ level: string; text: string; time: string }> = []
let pageOpsSource: string | null = null

function log(msg: string): void {
  console.log(`[web-agent] ${msg}`)
}

function nowIso(): string {
  return new Date().toISOString()
}

function pushConsole(level: unknown, text: string): void {
  const name = typeof level === 'string' ? level : typeof level === 'number' ? (level >= 3 ? 'error' : level === 2 ? 'warn' : 'log') : 'log'
  consoleRing.push({ level: name, text, time: nowIso() })
  while (consoleRing.length > CONSOLE_RING_MAX) consoleRing.shift()
}

/** The page-ops runner: evaluates the shared ops expression, then one op. */
function runnerCode(a: RunPayload): string {
  const payload = JSON.stringify({ op: a.op, selector: a.selector, text: a.text, value: a.value, code: a.code, attr: a.attr })
  return `(function(){
    var a = ${payload};
    var shared = ${pageOpsSource ?? 'null'};
    var op = shared && shared.ops ? shared.ops[a.op] : null;
    if (typeof op !== 'function') return { ok: false, error: 'op ' + a.op + ' não suportada pelo ops source' };
    return Promise.resolve().then(function () { return op(a); })
      .then(function (r) { return { ok: true, data: r }; },
            function (e) { return { ok: false, error: String((e && e.message) || e) }; });
  })()`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveP) => setTimeout(resolveP, ms))
}

function ensureView(owner: BrowserWindow): WebContentsView {
  if (view) {
    const stale = view.webContents.isDestroyed() || !hostWindow || hostWindow.isDestroyed() || hostWindow !== owner
    if (stale) dropView()
  }
  if (view) return view
  consoleRing = []
  const created = new WebContentsView({
    webPreferences: {
      partition: VIEW_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  created.setBackgroundColor('#ffffff')
  const ses = created.webContents.session
  // Real sites probe the UA; strip the Electron marker so automation reads as a
  // plain Chromium browser.
  ses.setUserAgent(ses.getUserAgent().replace(/\sElectron\/[\d.]+/i, ''))
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.on('console-message', (...args: unknown[]) => {
    const evt = args[0] as { level?: unknown; message?: unknown } | undefined
    if (evt && typeof evt === 'object' && 'message' in evt) {
      pushConsole(evt.level, String(evt.message ?? ''))
      return
    }
    const [, level, message] = args as [unknown, unknown, unknown]
    pushConsole(level, String(message ?? ''))
  })
  created.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) pushConsole('error', `did-fail-load ${code} ${desc} ${url}`)
  })
  view = created
  hostWindow = owner
  owner.contentView.addChildView(created)
  log('view created (partition ' + VIEW_PARTITION + ')')
  return created
}

function dropView(): void {
  if (!view) return
  try {
    const wc = view.webContents
    if (!wc.isDestroyed()) {
      wc.removeAllListeners('console-message')
      wc.removeAllListeners('did-fail-load')
    }
    if (hostWindow && !hostWindow.isDestroyed()) hostWindow.contentView.removeChildView(view)
  } catch {
    // the window or view may already be gone during teardown
  }
  view = null
  hostWindow = null
  log('view dropped')
}

async function navigate(url: string): Promise<RunResult> {
  if (!view) return { ok: false, error: 'view not mounted — navigate from the Browser tab with scope "full"' }
  try {
    await view.webContents.loadURL(url)
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    if (!/ERR_ABORTED/.test(msg)) return { ok: false, error: msg }
  }
  await sleep(300)
  return {
    ok: true,
    data: { url: view.webContents.getURL(), title: await view.webContents.getTitle() },
  }
}

async function runOp(a: RunPayload): Promise<RunResult> {
  if (!view) return { ok: false, error: 'view not mounted' }
  const wc = view.webContents
  switch (a.op) {
    case 'click':
    case 'fill':
    case 'read':
    case 'eval': {
      const r = (await wc.executeJavaScript(runnerCode(a), true)) as RunResult
      if (r.ok && a.op === 'fill') {
        // The value never leaves this process: the result names the field, not the content.
        const data = r.data as { filled?: boolean; value?: unknown }
        const filled = data?.filled === true
        return { ok: true, data: { filled, length: typeof a.value === 'string' ? a.value.length : 0 } }
      }
      return r
    }
    case 'wait_for': {
      const deadline = Date.now() + Math.min(Number(a.timeoutMs) || DEFAULT_WAIT_MS, MAX_WAIT_MS)
      const find =
        a.selector !== undefined
          ? `!!document.querySelector(${JSON.stringify(a.selector)})`
          : `(${pageOpsSource ?? ''})().findByText(${JSON.stringify(a.text ?? '')}) !== null`
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const found = await wc.executeJavaScript(`Promise.resolve().then(function(){ return (${find}); }).catch(function(){ return false; })`, true)
        if (found === true) return { ok: true, data: { found: true } }
        if (Date.now() > deadline) {
          return { ok: false, error: `wait_for timeout: ${a.selector ?? a.text}` }
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(FIND_INTERVAL_MS)
      }
    }
    case 'wait': {
      const ms = Math.min(Number(a.ms) || 1000, MAX_WAIT_MS)
      await sleep(ms)
      return { ok: true, data: { waited: ms } }
    }
    case 'console':
      return { ok: true, data: { entries: consoleRing.slice(-CONSOLE_RING_MAX) } }
    case 'screenshot': {
      const image = await wc.capturePage()
      return { ok: true, data: { dataUrl: image.toDataURL() } }
    }
    default:
      return { ok: false, error: `unknown web-agent op "${a.op}"` }
  }
}

/** Sender must be the app's own main window renderer. */
function trusted(event: IpcMainInvokeEvent, owner: () => BrowserWindow | null | undefined): boolean {
  const win = owner()
  return !!win && !win.isDestroyed() && event.sender === win.webContents
}

export function registerWebAgent(owner: () => BrowserWindow | null | undefined): void {
  ipcMain.removeHandler('web-agent:attach')
  ipcMain.handle('web-agent:attach', (event, rect: Rect, opsSource: unknown) => {
    if (!trusted(event, owner)) return { ok: false, error: 'untrusted sender' }
    if (typeof opsSource !== 'string' || opsSource.length === 0) return { ok: false, error: 'ops source required' }
    pageOpsSource = opsSource
    const win = owner()
    if (!win) return { ok: false, error: 'main window gone' }
    const v = ensureView(win)
    if (
      rect &&
      Number.isFinite(rect.x) &&
      Number.isFinite(rect.y) &&
      Number.isFinite(rect.width) &&
      Number.isFinite(rect.height) &&
      rect.width > 0 &&
      rect.height > 0
    ) {
      v.setBounds(rect)
    }
    v.setVisible(true)
    return { ok: true }
  })
  ipcMain.removeHandler('web-agent:bounds')
  ipcMain.handle('web-agent:bounds', (event, rect: Rect) => {
    if (!trusted(event, owner)) return { ok: false }
    if (view && rect && rect.width > 0 && rect.height > 0) view.setBounds(rect)
    return { ok: true }
  })
  ipcMain.removeHandler('web-agent:detach')
  ipcMain.handle('web-agent:detach', (event) => {
    if (!trusted(event, owner)) return { ok: false }
    dropView()
    return { ok: true }
  })
  ipcMain.removeHandler('web-agent:navigate')
  ipcMain.handle('web-agent:navigate', async (event, url: unknown) => {
    if (!trusted(event, owner)) return { ok: false, error: 'untrusted sender' }
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, error: 'http(s) url required' }
    const win = owner()
    if (!win) return { ok: false, error: 'main window gone' }
    ensureView(win)
    return navigate(url)
  })
  ipcMain.removeHandler('web-agent:run')
  ipcMain.handle('web-agent:run', async (event, payload: RunPayload) => {
    if (!trusted(event, owner)) return { ok: false, error: 'untrusted sender' }
    if (!payload || typeof payload.op !== 'string') return { ok: false, error: 'op required' }
    try {
      return await runOp(payload)
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  })
  log('registered')
}
