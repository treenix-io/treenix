import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { planKernelUpgrade } from '#tools/upgrade-kernel-plan'
import { applyFsUpgrade, backupFsUpgrade, planFsUpgrade } from '#tools/upgrade-kernel-fs'
import { nativeUpgradeValidator } from '#tools/upgrade-kernel-schema'
import { createRegistry } from '#kernel/registry'
import { kernelManifest } from '#kernel/builtins'
import { authManifest } from '#kernel/auth-module'
import { openFsMountTarget } from '#kernel/mount-fs'
import { upgradeKernelCli } from '#tools/upgrade-kernel'

test('converts stable account principals and subscribe grants without changing anonymous identity', () => {
  const plan = planKernelUpgrade([
    { path: '/auth/users/alice', body: { $type: 't.user', $id: 'alice-id', name: 'alice' } },
    { path: '/page', body: { $type: 'doc.page', $id: 'page-id', $owner: 'alice', $acl: [{ g: 'u:alice', p: 9 }], createdBy: 'anon:kept', $rev: 1 } },
  ], { validate: () => [] })
  assert.equal(plan.documents[1].body.$owner, 'u:alice-id')
  assert.deepEqual(plan.documents[1].body.$acl, [{ subject: { group: 'u:alice-id' }, grant: 1 }])
  assert.equal(plan.documents[1].body.createdBy, 'anon:kept')
  assert.equal('$rev' in plan.documents[1].body, false)
})

test('reports duplicate identity and uncertain sticky deny before any application', () => {
  const plan = planKernelUpgrade([
    { path: '/a', body: { $type: 'dir', $id: 'duplicate', $acl: [{ g: 'authenticated', p: 0 }] } },
    { path: '/b', body: { $type: 'dir', $id: 'duplicate' } },
  ], { validate: () => [] })
  assert.ok(plan.findings.some(finding => finding.code === 'DUPLICATE_ID' && finding.severity === 'error'))
  assert.ok(plan.findings.some(finding => finding.code === 'STICKY_DENY_REQUIRES_REVIEW' && finding.severity === 'error'))
})

test('resolves move lineage and gives archived copies separate stable identities', () => {
  let sequence = 0
  const plan = planKernelUpgrade([
    { path: '/old', body: { $type: 'moved', $id: 'stable', $ref: '/new' } },
    { path: '/new', body: { $type: 'dir', $id: 'stable' } },
    { path: '/sys/trash/deletion/new', body: { $type: 'dir', $id: 'stable' } },
  ], { validate: () => [], id: () => `generated-${sequence++}` })
  assert.deepEqual(plan.retired, ['/old'])
  assert.equal(plan.documents.find(document => document.path === '/new')?.body.$id, 'stable')
  assert.equal(plan.documents.find(document => document.path.startsWith('/sys/trash/'))?.body.$id, 'generated-0')
  assert.equal(plan.findings.some(finding => finding.severity === 'error'), false)
})

test('requires byte-faithful backup and repeats the same accepted filesystem plan as a no-op', async () => {
  const area = await mkdtemp(join(fileURLToPath(new URL('../../../../temp/', import.meta.url)), 'upgrade-kernel-fixtures-'))
  const root = join(area, 'data')
  await mkdir(root)
  await writeFile(join(root, '.treenix-version'), '1\n')
  const before = '{"$type":"dir","$id":"root-id","$rev":1}\n'
  await writeFile(join(root, '$.json'), before)
  const plan = await planFsUpgrade(root, { validate: () => [] }, { files: 10, bytes: 4096 })
  const backup = join(area, 'backup')
  await backupFsUpgrade(plan, backup)
  assert.equal(await readFile(join(backup, 'files', '$.json'), 'utf8'), before)
  await applyFsUpgrade(plan, backup)
  const after = await readFile(join(root, '$.json'), 'utf8')
  await applyFsUpgrade(plan, backup)
  assert.equal(await readFile(join(root, '$.json'), 'utf8'), after)
  assert.equal('$rev' in JSON.parse(after), false)
})

test('refuses missing version and changed input without touching source', async () => {
  const area = await mkdtemp(join(fileURLToPath(new URL('../../../../temp/', import.meta.url)), 'upgrade-kernel-fixtures-'))
  await assert.rejects(planFsUpgrade(area, { validate: () => [] }, { files: 10, bytes: 4096 }))
  await writeFile(join(area, '.treenix-version'), '1\n')
  await writeFile(join(area, '$.json'), '{"$type":"dir","$id":"fixed"}')
  const plan = await planFsUpgrade(area, { validate: () => [] }, { files: 10, bytes: 4096 })
  const backup = `${area}-backup`
  await backupFsUpgrade(plan, backup)
  const changed = '{"$type":"dir","$id":"fixed","new":true}'
  await writeFile(join(area, '$.json'), changed)
  await assert.rejects(applyFsUpgrade(plan, backup))
  assert.equal(await readFile(join(area, '$.json'), 'utf8'), changed)
  assert.equal(await readFile(join(area, '.treenix-version'), 'utf8'), '1\n')
})

test('reports actual installed schema errors and admits converted data through the native filesystem owner', async t => {
  const registry = createRegistry()
  registry.publish(kernelManifest)
  registry.publish(authManifest)
  const validate = nativeUpgradeValidator(registry)
  const invalid = planKernelUpgrade([{ path: '/bad', body: { $type: 't.user', $id: 'bad', name: 'bad', status: 'invented' } }],
    { validate, anonymous: { instance: 'upgrade-fixture', key: 'ab'.repeat(32) } })
  assert.ok(invalid.findings.some(finding => finding.code.startsWith('SCHEMA_INVALID:')))
  const root = await mkdtemp(join(fileURLToPath(new URL('../../../../temp/', import.meta.url)), 'upgrade-kernel-fixtures-'))
  await writeFile(join(root, '.treenix-version'), '1\n')
  await writeFile(join(root, '$.json'), '{"$type":"dir","$id":"kept-id","$rev":8}')
  const plan = await planFsUpgrade(root, { validate }, { files: 10, bytes: 4096 })
  assert.equal(plan.conversion.findings.some(finding => finding.severity === 'error'), false)
  const backup = `${root}-backup`
  await backupFsUpgrade(plan, backup)
  await applyFsUpgrade(plan, backup)
  const target = await openFsMountTarget({ directory: root, instance: 'upgrade-fixture', logicalBase: '/', external: 'none' })
  t.after(() => target.close())
  const result = await target.store.scan({ range: { node: '/' }, budget: { nodes: 10, bytes: 4096, exprWork: 1000, deadline: Date.now() + 1000 } })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].$id, 'kept-id')
  assert.equal(result.items[0].$type, 't.dir')
  assert.deepEqual(result.items[0].$pos.instance, 'upgrade-fixture')
  assert.equal((await planFsUpgrade(root, { validate }, { files: 10, bytes: 4096 })).completed, true)
})

test('the explicit filesystem CLI requires its dry-run artifact and backup, then repeats without new writes', async () => {
  const area = await mkdtemp(join(fileURLToPath(new URL('../../../../temp/', import.meta.url)), 'upgrade-kernel-fixtures-'))
  const root = join(area, 'data')
  await mkdir(root)
  await writeFile(join(root, '.treenix-version'), '1\n')
  await writeFile(join(root, '$.json'), '{"$type":"dir","$id":"cli-id","$rev":4}')
  const deployment = join(area, 'deployment.mjs')
  await writeFile(deployment, `import { createRegistry } from ${JSON.stringify(new URL('../kernel/registry.ts', import.meta.url).href)};
import { kernelManifest } from ${JSON.stringify(new URL('../kernel/builtins.ts', import.meta.url).href)};
const registry = createRegistry(); registry.publish(kernelManifest);
export const upgradeDeployment = { registry };
`)
  const plan = join(area, 'plan.json')
  const args = ['--root', root, '--deployment', deployment, '--plan', plan]
  await upgradeKernelCli([...args, '--dry-run'])
  assert.equal('$rev' in JSON.parse(await readFile(join(root, '$.json'), 'utf8')), true)
  await assert.rejects(upgradeKernelCli([...args, '--apply']))
  const backup = join(area, 'backup')
  await upgradeKernelCli([...args, '--apply', '--backup', backup])
  const accepted = await readFile(join(root, '$.json'), 'utf8')
  await upgradeKernelCli([...args, '--apply', '--backup', backup])
  assert.equal(await readFile(join(root, '$.json'), 'utf8'), accepted)
  assert.equal('$rev' in JSON.parse(accepted), false)
})


test('blocks BSON dates and binary payloads that the operator JSON artifact cannot preserve', () => {
  const plan = planKernelUpgrade([
    { path: '/date', body: { $type: 'dir', $id: 'date-id', changedAt: new Date(0) } },
    { path: '/binary', body: { $type: 'dir', $id: 'binary-id', data: Buffer.from([1, 2]) } },
  ], { validate: () => [] })
  assert.deepEqual(plan.findings.filter(finding => finding.code === 'NON_JSON_PAYLOAD_REQUIRES_REVIEW')
    .map(finding => [finding.path, finding.severity]), [['/date', 'error'], ['/binary', 'error']])
})
