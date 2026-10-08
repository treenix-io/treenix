import { KernelError } from '#errors'

const originalError = console.error
const originalInfo = console.info

console.error = (error: unknown, ...rest: unknown[]) => {
  originalError(error, ...rest)
  process.send?.({ type: 'error', code: error instanceof KernelError ? error.code : undefined })
}
console.info = (...values: unknown[]) => {
  originalInfo(...values)
  process.send?.({ type: 'info', values })
}

process.once('exit', () => {
  console.error = originalError
  console.info = originalInfo
})

await import('#server/native-main')
