// Unified logging: tree-persisted nodes + ring buffer fallback + debug filter + console intercept

import dayjs from 'dayjs'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  t: number
  level: LogLevel
  msg: string
  code?: string
  sub?: string
  userId?: string
  method?: string
  path?: string
}

// ── Execution context provider — set by comp/index.ts to avoid circular imports ──

type CtxProvider = () => Record<string, unknown> | null
let _getCtx: CtxProvider = () => null

export function setCtxProvider(fn: CtxProvider) { _getCtx = fn }

// ── Log listeners ──

type OnLog = (entry: LogEntry) => void
const listeners: OnLog[] = []

export function addOnLog(fn: OnLog) { listeners.push(fn) }

// ── Timestamp ID: YYMMDD-HHmmss-mmm-NNN ──

let lastMs = 0
let seq = 0

export function makeLogPath(): string {
  const now = Date.now()
  if (now === lastMs) {
    seq++
  } else {
    lastMs = now
    seq = 0
  }

  const stamp = dayjs(now).format('YYMMDD-HHmmss-SSS')
  const sq = String(seq).padStart(3, '0')

  return `/sys/logs/${stamp}-${sq}`
}

function notify(entry: LogEntry) {
  for (const fn of listeners) fn(entry)
}

// ── Ring buffer (fallback before tree init) ──

const MAX = 2000
const buffer: LogEntry[] = []
let cursor = 0
let total = 0

function push(level: LogLevel, args: unknown[]) {
  // Extract [tag] → sub
  let sub: string | undefined
  if (typeof args[0] === 'string') {
    const m = args[0].match(/^\[([^\]]+)\]$/)
    if (m) {
      sub = m[1]
      args = args.slice(1)
    }
  }

  // Extract UPPER_SNAKE code
  let code: string | undefined
  if (args.length > 1 && typeof args[0] === 'string' && /^[A-Z][A-Z0-9_]+$/.test(args[0])) {
    code = args[0]
    args = args.slice(1)
  }

  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  const ctx = _getCtx()

  const entry: LogEntry = {
    t: Date.now(),
    level,
    msg,
    code,
    sub,
    userId: ctx?.userId as string | undefined,
    method: ctx?.method as string | undefined,
    path: ctx?.path as string | undefined,
  }

  if (listeners.length) {
    notify(entry)
  } else {
    if (total < MAX) {
      buffer.push(entry)
    } else {
      buffer[cursor] = entry
    }
    cursor = (cursor + 1) % MAX
    total++
  }
}

/** Get ordered log entries from ring buffer (oldest first) */
function getOrdered(): LogEntry[] {
  if (total <= MAX) return buffer.slice()
  return [...buffer.slice(cursor), ...buffer.slice(0, cursor)]
}

// ── Query (ring buffer fallback — when tree available, use sift via getChildren) ──

export interface LogQuery {
  grep?: string
  level?: LogLevel | LogLevel[]
  head?: number
  tail?: number
}

export function queryLogs(opts: LogQuery = {}): LogEntry[] {
  let entries = getOrdered()

  if (opts.level) {
    const levels = Array.isArray(opts.level) ? opts.level : [opts.level]
    entries = entries.filter(e => levels.includes(e.level))
  }

  if (opts.grep) {
    const re = new RegExp(opts.grep, 'i')
    entries = entries.filter(e => re.test(e.msg))
  }

  if (opts.tail) entries = entries.slice(-opts.tail)
  if (opts.head) entries = entries.slice(0, opts.head)

  return entries
}

export function logStats() {
  return { buffered: Math.min(total, MAX), total, max: MAX }
}

// ── Debug filter ──

const enabled = new Set<string>()
let all = false

export function setDebug(filter: string) {
  enabled.clear()
  all = false
  if (filter === '*') { all = true; return }
  for (const s of filter.split(',')) {
    const t = s.trim()
    if (t) enabled.add(t)
  }
}

if (typeof process !== 'undefined' && process.env?.DEBUG) {
  setDebug(process.env.DEBUG)
}

;(globalThis as Record<string, unknown>).setDebug = setDebug

const isTTY = typeof process !== 'undefined' && process.stderr?.isTTY

export function createLogger(name: string) {
  const tag = `[${name}]`
  const fmt = (color: string, args: unknown[]) => {
    if (!isTTY) return [tag, ...args]
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    return [`${color}[${name}] ${msg}\x1b[0m`]
  }
  return {
    debug(...args: unknown[]) { if (all || enabled.has(name)) console.debug(...fmt('\x1b[36m', args)) },
    info(...args: unknown[]) { console.info(...fmt('\x1b[36m', args)) },
    warn(...args: unknown[]) { console.warn(...fmt('\x1b[33m', args)) },
    error(...args: unknown[]) { console.error(...fmt('\x1b[31m', args)) },
  }
}

// ── Console intercept — call once at startup ──

let intercepted = false

export function interceptConsole() {
  if (intercepted) return
  intercepted = true

  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    const orig = console[level]
    console[level] = (...args: unknown[]) => {
      push(level, args)
      orig.apply(console, args)
    }
  }

  // console.log → info level
  const origLog = console.log
  console.log = (...args: unknown[]) => {
    push('info', args)
    origLog.apply(console, args)
  }
}
