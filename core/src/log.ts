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

;(globalThis as any).setDebug = setDebug

export function createLogger(name: string) {
  const tag = `[${name}]`
  return {
    debug(...args: unknown[]) { if (all || enabled.has(name)) console.debug(tag, ...args) },
    info(...args: unknown[]) { console.info(tag, ...args) },
    warn(...args: unknown[]) { console.warn(tag, ...args) },
    error(...args: unknown[]) { console.error(tag, ...args) },
  }
}
