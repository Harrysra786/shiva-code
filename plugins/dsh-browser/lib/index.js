// dsh-browser host half: lets the agent drive the better-sidebar browser tab.
// The tab itself is a dsh-better-sidebar builtin — a sandboxed, cross-origin
// iframe — so the agent cannot script the visited page (no DOM, console or
// clicks on external sites). What it can do: open the tab at a URL, screenshot
// the app window that shows it, and open URLs in the system browser. The client
// half owns the tab (betterSidebar.openTab) and the window capture; this host
// half relays one command at a time and stores screenshots under the workspace.

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const inject = ['webServer', 'sessions', 'tools']

const WIN = process.platform === 'win32'

/** Workspace-relative folder the screenshots land in. */
export const SHOTS_FOLDER = '.browser-shots'

let seq = 0
let pending = null
const waiters = new Map()

function log(msg) {
  console.log(`[dsh-browser] ${msg}`)
}

/**
 * The workspace for one request. The session's own cwd is authoritative: the
 * client-supplied `cwd` can be the harness launch root (a desktop-only
 * directory) while the conversation lives in a workspace.
 */
async function workspaceOf(ctx, payload) {
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
  if (sessionId) {
    const live = ctx.get('sessions')?.get(sessionId)?.header?.cwd
    if (typeof live === 'string' && live) return live
    const persistence = ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      let stored
      try { stored = (await persistence.inspect(sessionId)).meta.cwd }
      catch { /* unknown session */ }
      if (typeof stored === 'string' && stored) return stored
    }
  }
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd.trim() : ''
  if (cwd) return cwd
  return process.cwd()
}

/** Open a URL in the machine's default browser. */
function openExternal(url) {
  return new Promise((resolveP) => {
    const ok = () => resolveP(true)
    const fail = () => resolveP(false)
    try {
      if (WIN) spawn('rundll32', ['url.dll,FileProtocolHandler', url], { windowsHide: true }).on('error', fail).on('close', ok)
      else if (process.platform === 'darwin') spawn('open', [url]).on('error', fail).on('close', ok)
      else spawn('xdg-open', [url]).on('error', fail).on('close', ok)
    } catch { resolveP(false) }
  })
}

/** Queue one command for the client and await its result (bounded). */
function issue(cmd) {
  const id = String(++seq)
  pending = { id, ...cmd }
  return new Promise((resolveP) => {
    waiters.set(id, resolveP)
    setTimeout(() => {
      if (waiters.has(id)) {
        waiters.delete(id)
        resolveP({ ok: false, error: 'timeout — a aba Browser não respondeu (ela está aberta?)' })
      }
      if (pending && pending.id === id) pending = null
    }, 15000)
  })
}

/** Settle the command the client answered. */
function settle(id, result) {
  const key = String(id)
  const waiter = waiters.get(key)
  if (waiter) { waiters.delete(key); waiter(result) }
  if (pending && pending.id === key) pending = null
}

/** Decode a data URL screenshot into the workspace and return its path. */
async function saveShot(workspace, dataUrl) {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl ?? ''))
  if (!m) throw new Error('captura inválida')
  const dir = join(workspace, SHOTS_FOLDER)
  await mkdir(dir, { recursive: true })
  const name = `shot-${Date.now()}.png`
  await writeFile(join(dir, name), Buffer.from(m[1], 'base64'))
  return `${SHOTS_FOLDER}/${name}`
}

/** Ops the agent tool exposes. */
const BROWSER_OPS = ['open', 'navigate', 'focus', 'screenshot', 'open_external']

/** Build the agent tool that drives the better-sidebar browser tab. */
function createTool(ctx) {
  return defineTool({
    name: 'browser',
    description:
      'Drive the sidebar Browser tab and the system browser. ops: open (open the Browser tab, optionally at url) · ' +
      'navigate (open the Browser tab at url) · focus (bring an open Browser tab to the front) · screenshot (capture the app ' +
      'window showing the Browser tab; saved under the workspace and returned as a path) · open_external (open url in the ' +
      'machine\'s default browser, e.g. an OAuth or dashboard link). The visited page is a cross-origin sandbox: this tool can ' +
      'navigate and screenshot it, but cannot read its DOM, console or click inside it — for the workspace prototype use ' +
      'prototype_automation, which has full click/fill/read/eval/console control.',
    parameters: {
      op: { type: 'string', required: true, enum: BROWSER_OPS, description: 'Operation to run.' },
      url: { type: 'string', description: 'Target URL (open/navigate/open_external).' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => [{ type: 'text', text: `browser ${args.op}: ${JSON.stringify(value)}` }],
    },
    async execute(args, exec) {
      const workspace = await workspaceOf(ctx, {
        cwd: exec?.agent?.session?.header?.cwd,
        sessionId: exec?.agent?.session?.header?.id,
      })
      const op = String(args.op)
      if (op === 'open_external') {
        const url = String(args.url ?? '')
        if (!url) throw new Error('url obrigatória')
        await openExternal(url)
        return { ok: true, url }
      }
      if (op === 'screenshot') {
        const r = await issue({ op: 'screenshot' })
        if (!r.ok) return r
        const file = await saveShot(workspace, r.dataUrl)
        return { ok: true, file }
      }
      return await issue({ op, url: typeof args.url === 'string' ? args.url : undefined })
    },
    presentCall: (args) => ({ card: 'generic', title: `Browser: ${args.op}`, kind: 'other', rawInput: args }),
  })
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolveP, rejectP) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > limitBytes) { rejectP(new Error('payload too large')); req.destroy(); return } chunks.push(c) })
    req.on('end', () => { try { resolveP(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { rejectP(new Error('invalid JSON body')) } })
    req.on('error', rejectP)
  })
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === String(req.headers.host ?? '') } catch { return false }
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    log('webServer unavailable — plugin inactive')
    return
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    const method = url.pathname.slice('/browser/api/'.length) || ''
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'cross-origin request rejected' })
    let payload = {}
    try { payload = await readBody(req) } catch (e) { return json(res, 400, { ok: false, error: e.message }) }
    try {
      switch (method) {
        case 'pending': {
          // Deliver once: the client answers with `result`.
          const cmd = pending
          pending = null
          return json(res, 200, { ok: true, cmd })
        }
        case 'result':
          settle(payload.id, { ok: payload.ok !== false, dataUrl: payload.dataUrl ?? null, error: payload.error ?? null })
          return json(res, 200, { ok: true })
        case 'status':
          return json(res, 200, { ok: true, shots: SHOTS_FOLDER })
        default:
          return json(res, 404, { ok: false, error: `unknown method "${method}"` })
      }
    } catch (e) {
      return json(res, 400, { ok: false, error: String((e && e.message) || e) })
    }
  }

  ctx.effect(() => webServer.register({ kind: 'prefix', path: '/browser/api', handler }), 'dsh-browser: api')

  const tools = ctx.get('tools')
  if (tools && typeof tools.register === 'function') {
    const tool = createTool(ctx)
    ctx.effect(() => tools.register(tool), `dsh-browser: tool ${tool.name}`)
    log(`agent tool: ${tool.name}`)
  }
  log('loaded')
}
