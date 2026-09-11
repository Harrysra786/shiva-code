// dsh-tool-guard host half: enforces two process laws at the tool seam instead
// of trusting prose. A guard is evaluated after every `tools/pre-execute`
// listener and is monotonic — once it returns a reason the call is denied and
// no later listener can turn it back into permission. The rules:
//   1. the principal agent writes only process artifacts (`mds/` and the
//      `prototype/` folder); product code is a subagent's job;
//   2. no agent may write `status: done` into a ticket — Done is the human's
//      move on the Kanban.
// Subagents (delegation depth >= 1) are exempt from rule 1: writing code is
// exactly what they are for.

import { resolve, relative, isAbsolute } from 'node:path'

export const inject = ['tools']

/** Tools whose arguments carry a destination path and file text. */
const GUARDED = new Set(['write', 'edit'])

/** A frontmatter status of done, the human-only terminal state. */
const DONE_RE = /^\s*status\s*:\s*done\b/im

/** Folders the principal agent may write inside, relative to the workspace. */
const DEFAULT_ALLOWED_ROOTS = ['mds', 'prototype']

function log(msg) {
  console.log(`[dsh-tool-guard] ${msg}`)
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

/** Delegation depth: 0 is the principal agent, >= 1 is a subagent. */
function delegationDepthOf(agent) {
  const runtime = agent?.options?.subagentDepth
  if (typeof runtime === 'number') return runtime
  const header = agent?.session?.header?.delegationDepth
  return typeof header === 'number' ? header : 0
}

/** True when `p` (resolved against cwd) names a file inside `<cwd>/<folder>`. */
function inside(cwd, p, folder) {
  const root = resolve(cwd, folder)
  const abs = resolve(cwd, p)
  const rel = relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * The guard body: returns a denial reason, or undefined to leave the call
 * unchanged. It is synchronous, as the guard contract requires.
 */
function check(exec, allowedRoots) {
  if (!GUARDED.has(exec.name)) return undefined
  const args = (typeof exec.arguments === 'object' && exec.arguments !== null) ? exec.arguments : {}

  const text = exec.name === 'write' ? str(args.content) : str(args.new_string)
  if (DONE_RE.test(text)) {
    return 'Blocked: "status: done" is the human\'s move on the Kanban — never set it yourself'
  }

  const agent = exec.agent
  if (agent === undefined) return undefined
  if (delegationDepthOf(agent) !== 0) return undefined

  const cwd = str(agent?.session?.header?.cwd) || process.cwd()
  const file = str(args.file_path)
  if (allowedRoots.some((folder) => inside(cwd, file, folder))) return undefined
  return `Blocked: the principal agent writes only ${allowedRoots.join('/ and ')}/ — code is a subagent's job (got ${file || '<empty>'})`
}

export function apply(ctx, config = {}) {
  const tools = ctx.get('tools')
  if (!tools || typeof tools.guard !== 'function') {
    log('tools service unavailable — guard not registered')
    return
  }
  const configured = config.allowedRoots
  const allowedRoots = Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_ALLOWED_ROOTS

  ctx.effect(() => tools.guard((exec) => check(exec, allowedRoots)), 'dsh-tool-guard: guard')
  log(`loaded (allowed roots: ${allowedRoots.join(', ')})`)
}
