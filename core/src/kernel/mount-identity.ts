import { createHash } from 'node:crypto'
import { KernelError } from '#errors'

/** Aliases cannot reuse the physical source's identity in a lane that also reads that source. */
export function createMountIdentity(kind: 'f' | 's', origin: string, node: string, component: string) {
  const namespace = createHash('sha256').update(JSON.stringify([origin, node, component])).digest('hex')
  const prefix = `${kind}:${namespace}:`
  const encode = (value: string) => Buffer.from(value).toString('base64url')

  function source(value: string): string {
    if (!value.startsWith(prefix)) throw new KernelError('INVALID', 'Identity belongs to another mount')
    const encoded = value.slice(prefix.length)
    const decoded = Buffer.from(encoded, 'base64url').toString()
    if (encode(decoded) !== encoded) throw new KernelError('INVALID', 'Malformed mount identity')
    return decoded
  }

  return {
    id: (value: string) => `${prefix}${encode(value)}`,
    source,
    owns: (value: string) => value.startsWith(prefix),
  }
}
