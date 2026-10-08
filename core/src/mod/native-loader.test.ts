import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mapRegistry, register, registerLegacy, resolveExactEntry, unregister } from '#core/registry'
import { KernelError } from '#errors'
import { clearAmbientRegistrations, clearCollectedModules, publishModules } from '#kernel/manifest'
import { createRegistry } from '#kernel/registry'
import { clearModRegistry, loadAllMods, loadLocalMods, publishLoadedModules } from './loader'

const componentModule = new URL('../comp/index.ts', import.meta.url).href

describe('native module loading', () => {
  let dir: string
  let restore: () => void
  beforeEach(async () => {
    const scratch = resolve(import.meta.dirname, '../../../../temp')
    await mkdir(scratch, { recursive: true })
    dir = await mkdtemp(join(scratch, 'native-mods-'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@test/native-mods' }))
    const previous = mapRegistry((type, context) => ({ type, context, entry: resolveExactEntry(type, context)! }))
    clearModRegistry()
    clearAmbientRegistrations()
    clearCollectedModules()
    restore = () => {
      mapRegistry((type, context) => { unregister(type, context) })
      clearAmbientRegistrations()
      clearCollectedModules()
      clearModRegistry()
      for (const { type, context, entry } of previous) registerLegacy(type, context, entry.handler, entry.meta)
    }
  })
  afterEach(() => restore())

  async function mod(name: string, type: string, schemaType = type, suffix = '', root = dir): Promise<void> {
    const path = join(root, name)
    await mkdir(join(path, 'schemas'), { recursive: true })
    await writeFile(join(path, 'server.ts'), `import { registerType } from ${JSON.stringify(componentModule)};\nregisterType(${JSON.stringify(type)}, class Item {});\n${suffix}`)
    await writeFile(join(path, 'schemas', 'item.json'), JSON.stringify({ $id: schemaType, type: 'object', properties: {} }))
  }

  it('returns one complete manifest per module and reuses it for another instance', async () => {
    await mod('alpha', 'native.alpha')
    await mod('beta', 'native.beta')
    const first = await loadLocalMods(dir, 'kernel')
    assert.deepEqual(first.loaded, ['alpha', 'beta'])
    assert.deepEqual(first.failed, [])
    assert.deepEqual(first.manifests.map(manifest => manifest.id), ['@test/native-mods/alpha', '@test/native-mods/beta'])
    const second = await loadLocalMods(dir, 'kernel')
    assert.deepEqual(second.loaded, first.loaded)
    assert.deepEqual(second.failed, [])
    assert.equal(second.manifests[0], first.manifests[0])
    const a = createRegistry(), b = createRegistry()
    publishModules(a, first.manifests)
    publishModules(b, second.manifests)
    assert.equal(a.digest, b.digest)
    assert.equal(a.type('native.alpha').module, '@test/native-mods/alpha')
    assert.equal(b.type('native.beta').module, '@test/native-mods/beta')
  })

  it('discards a failed module while retaining complete siblings', async () => {
    await mod('bad', 'native.bad', 'native.bad', 'throw new TypeError();')
    await mod('good', 'native.good')
    const result = await loadLocalMods(dir, 'kernel')
    assert.deepEqual(result.loaded, ['good'])
    assert.deepEqual(result.failed.map(failed => failed.name), ['bad'])
    assert.ok(result.failed[0].error instanceof TypeError)
    assert.deepEqual(result.manifests.map(manifest => manifest.id), ['@test/native-mods/good'])
    const registry = createRegistry()
    publishModules(registry, result.manifests)
    assert.throws(() => registry.type('native.bad'), (error: unknown) => error instanceof KernelError && error.code === 'UNKNOWN_TYPE')
    assert.equal(registry.type('native.good').module, '@test/native-mods/good')
  })

  it('rejects a file schema for a type not declared by its module', async () => {
    await mod('foreign', 'native.owned', 'native.foreign')
    const result = await loadLocalMods(dir, 'kernel')
    assert.deepEqual(result.loaded, [])
    assert.deepEqual(result.manifests, [])
    assert.equal(result.failed.length, 1)
    assert.ok(result.failed[0].error instanceof KernelError)
    assert.equal(result.failed[0].error.code, 'FORBIDDEN')
  })

  it('keeps the legacy profile available without collecting native manifests', async () => {
    await mod('legacy', 'native.legacy')
    const result = await loadLocalMods(dir, 'server')
    assert.deepEqual(result.loaded, ['legacy'])
    assert.deepEqual(result.failed, [])
    assert.deepEqual(result.manifests, [])
  })

  it('rejects unscoped registrations before loading production kernel modules', async () => {
    register('native.unscoped', 'text', () => 'unscoped')
    await assert.rejects(() => loadAllMods('kernel'), (error: unknown) => error instanceof KernelError && error.code === 'INVALID')
  })

  it('uses a named ancestor package for internal modules', async () => {
    const nested = join(dir, 'src', 'mods')
    await mod('internal', 'native.internal', 'native.internal', '', nested)
    const result = await loadLocalMods(nested, 'kernel')
    assert.deepEqual(result.failed, [])
    assert.equal(result.manifests[0].id, '@test/native-mods/internal')
    const otherPackage = join(dir, 'other-package')
    await mkdir(otherPackage)
    await writeFile(join(otherPackage, 'package.json'), JSON.stringify({ name: '@test/alias-host' }))
    const alias = join(otherPackage, 'mods')
    await symlink(nested, alias, 'dir')
    const aliased = await loadLocalMods(alias, 'kernel')
    assert.deepEqual(aliased.failed, [])
    assert.equal(aliased.manifests[0], result.manifests[0])
  })

  it('reuses an imported manifest through a directory alias', async () => {
    await mod('item', 'native.aliased')
    const alias = join(dir, 'alias')
    await symlink(dir, alias, 'dir')
    const first = await loadLocalMods(dir, 'kernel')
    const second = await loadLocalMods(alias, 'kernel')
    assert.deepEqual(first.failed, [])
    assert.deepEqual(second.failed, [])
    assert.equal(second.manifests[0], first.manifests[0])
  })

  it('collects two package copies independently and refuses duplicate identities at boot', async () => {
    const firstRoot = join(dir, 'first'), secondRoot = join(dir, 'second')
    for (const root of [firstRoot, secondRoot]) {
      await mkdir(root)
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@test/copied-mods' }))
    }
    await mod('item', 'native.first', 'native.first', '', firstRoot)
    await mod('item', 'native.second', 'native.second', '', secondRoot)
    const first = await loadLocalMods(firstRoot, 'kernel'), second = await loadLocalMods(secondRoot, 'kernel')
    assert.deepEqual(first.failed, [])
    assert.deepEqual(second.failed, [])
    assert.equal(first.manifests[0].id, second.manifests[0].id)
    assert.equal(first.manifests[0].types[0].name, 'native.first')
    assert.equal(second.manifests[0].types[0].name, 'native.second')
    const registry = createRegistry(), before = registry.digest
    await assert.rejects(() => publishLoadedModules(registry, {
      loaded: [...first.loaded, ...second.loaded], failed: [], manifests: [...first.manifests, ...second.manifests],
    }), (error: unknown) => error instanceof KernelError && error.code === 'CONFLICT')
    assert.equal(registry.digest, before)
  })

  it('produces the same generation from identical modules installed at different paths', async () => {
    const firstRoot = join(dir, 'first'), secondRoot = join(dir, 'second')
    for (const root of [firstRoot, secondRoot]) {
      await mkdir(root)
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@test/copied-mods' }))
      await mod('item', 'native.identical', 'native.identical', '', root)
    }
    const first = await loadLocalMods(firstRoot, 'kernel'), second = await loadLocalMods(secondRoot, 'kernel')
    assert.deepEqual(first.failed, [])
    assert.deepEqual(second.failed, [])
    const a = createRegistry(), b = createRegistry()
    await publishLoadedModules(a, first)
    await publishLoadedModules(b, second)
    assert.equal(a.digest, b.digest)
    assert.notEqual(first.manifests[0], second.manifests[0])
  })

  it('refuses a failed import at boot unless partial modules are explicitly allowed', async () => {
    await mod('bad', 'native.bad', 'native.bad', 'throw new TypeError();')
    await mod('good', 'native.good')
    const result = await loadLocalMods(dir, 'kernel')
    const registry = createRegistry(), before = registry.digest
    await assert.rejects(() => publishLoadedModules(registry, result), (error: unknown) =>
      error instanceof KernelError && error.code === 'INVALID' && 'failures' in error && error.failures === result.failed)
    assert.equal(registry.digest, before)
    await publishLoadedModules(registry, result, { allowPartialMods: true })
    assert.equal(registry.type('native.good').module, '@test/native-mods/good')
    assert.throws(() => registry.type('native.bad'), (error: unknown) => error instanceof KernelError && error.code === 'UNKNOWN_TYPE')
  })

  it('names a legacy-only capability handler in a failed native boot', async () => {
    const path = join(dir, 'legacy-mount')
    await mkdir(join(path, 'schemas'), { recursive: true })
    const coreModule = new URL('../core/registry.ts', import.meta.url).href
    await writeFile(join(path, 'server.ts'), `import { registerType } from ${JSON.stringify(componentModule)};\nimport { register } from ${JSON.stringify(coreModule)};\nregisterType('native.mount', class Mount {}, {security:'user-capability'});\nregister('native.mount', 'mount', async () => { throw new Error('unused'); });`)
    await writeFile(join(path, 'schemas', 'mount.json'), JSON.stringify({ $id: 'native.mount', type: 'object', properties: {} }))
    const result = await loadLocalMods(dir, 'kernel')
    assert.deepEqual(result.failed, [])
    const registry = createRegistry(), before = registry.digest
    await assert.rejects(() => publishLoadedModules(registry, result, { allowPartialMods: true }), (error: unknown) =>
      error instanceof KernelError && error.code === 'INVALID' && 'type' in error && error.type === 'native.mount' && 'context' in error && error.context === 'mount')
    assert.equal(registry.digest, before)
  })
})
