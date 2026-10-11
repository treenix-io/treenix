import { open, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { Registry } from '#kernel/types'
import { isPosition } from '#kernel/input-boundary'

import { applyFsUpgrade, backupFsUpgrade, planFsUpgrade, fsUpgradeVersion, type FsUpgradePlan } from '#tools/upgrade-kernel-fs'
import { upgradeObject, isUpgradePlan, type UpgradeOptions } from '#tools/upgrade-kernel-plan'
import { nativeUpgradeValidator } from '#tools/upgrade-kernel-schema'

export interface UpgradeDeployment {
  readonly registry: Registry
  readonly anonymous?: UpgradeOptions['anonymous']
  readonly mongoClusters?: UpgradeOptions['mongoClusters']
  readonly mongoPosition?: UpgradeOptions['mongoPosition']
  readonly resolveDeny?: UpgradeOptions['resolveDeny']
}

/** Validate executable deployment input at the explicit administrative module boundary. */
function deployment(value: unknown): value is UpgradeDeployment {
  const input = upgradeObject(value)
  const registry = upgradeObject(input.registry)
  if (input.mongoPosition !== undefined && !isPosition(input.mongoPosition)) return false
  return typeof registry.digest === 'string' && ['module', 'publish', 'type', 'security', 'handler'].every(name => typeof registry[name] === 'function')
}

/** Validate a saved plan before allowing its paths to control an offline mutation. */
function savedPlan(value: unknown): value is FsUpgradePlan {
  const input = upgradeObject(value)
  const conversion = upgradeObject(input.conversion)
  if (typeof input.root !== 'string' || !Array.isArray(input.files) || !isUpgradePlan(conversion)) return false
  for (const value of input.files) {
    const file = upgradeObject(value)
    if (typeof file.name !== 'string' || file.name.startsWith('/')
      || file.name.split('/').some(part => part === '..' || part === '.' || part === '' || part.startsWith('.env') || part === 'secrets' || part === 'old')
      || typeof file.hash !== 'string' || !/^[0-9a-f]{64}$/.test(file.hash) || typeof file.bytes !== 'number') return false
    if (file.path !== undefined && (typeof file.path !== 'string' || !safePath(file.path))) return false
  }
  for (const value of conversion.documents) {
    const document = upgradeObject(value)
    if (typeof document.path !== 'string' || !safePath(document.path)) return false
    upgradeObject(document.body)
  }
  for (const value of conversion.findings) {
    const finding = upgradeObject(value)
    if (typeof finding.path !== 'string' || typeof finding.code !== 'string'
      || !['change', 'warning', 'error'].includes(String(finding.severity))) return false
  }
  for (const path of conversion.retired) if (typeof path !== 'string' || !safePath(path)) return false
  return true
}

/** Bind validation and explicit conversion decisions to the deployment's actual installed registry. */
export async function loadUpgradeDeployment(file: string): Promise<UpgradeOptions> {
  const loaded = await import(pathToFileURL(resolve(file)).href)
  const supplied: unknown = loaded.upgradeDeployment
  if (!deployment(supplied)) throw new Error('INVALID_UPGRADE_DEPLOYMENT')
  return { ...supplied, validate: nativeUpgradeValidator(supplied.registry) }
}

/** Plans contain logical paths, never filesystem traversal or reserved storage addresses. */
function safePath(path: string): boolean {
  return path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.' || part === '.treenix' || part === '.git'
    || part === 'secrets' || part === 'old' || part.startsWith('.env'))
}

/** Dry-run first; apply requires its exact saved plan and a fresh explicit backup directory. */
export async function upgradeKernelCli(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: {
    root: { type: 'string' }, deployment: { type: 'string' }, plan: { type: 'string' }, backup: { type: 'string' },
    apply: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, resume: { type: 'boolean' },
  } })
  if (values.root === undefined || values.deployment === undefined || values.plan === undefined
    || Boolean(values.apply) === Boolean(values['dry-run'])) throw new Error('REQUIRES_ROOT_DEPLOYMENT_PLAN_AND_ONE_MODE')
  const options = await loadUpgradeDeployment(values.deployment)
  if (values.resume && !values.apply) throw new Error('RESUME_REQUIRES_APPLY')
  if (await fsUpgradeVersion(resolve(values.root)) === 2) {
    console.log(JSON.stringify({ completed: true, documents: 0, findings: [] }))
    return
  }
  let plan: FsUpgradePlan
  if (values['dry-run']) {
    plan = await planFsUpgrade(values.root, options, { files: 10_000, bytes: 64 * 1024 * 1024 })
    const output = await open(resolve(values.plan), 'wx', 0o600)
    try { await output.writeFile(JSON.stringify(plan)); await output.sync() } finally { await output.close() }
  } else {
    if (values.backup === undefined) throw new Error('EXPLICIT_BACKUP_REQUIRED')
    const parsed: unknown = JSON.parse(await readFile(resolve(values.plan), 'utf8'))
    if (!savedPlan(parsed) || parsed.root !== resolve(values.root)) throw new Error('INVALID_UPGRADE_PLAN')
    plan = parsed
    if (plan.conversion.findings.some(finding => finding.severity === 'error')) throw new Error('UNRESOLVED_UPGRADE')
    for (const document of plan.conversion.documents) {
      if (options.validate(document.body, document.path).length !== 0) throw new Error('CURRENT_SCHEMA_CHANGED')
    }
    if (!values.resume) await backupFsUpgrade(plan, values.backup)
    await applyFsUpgrade(plan, values.backup)
  }
  console.log(JSON.stringify({ completed: plan.completed === true || values.apply === true,
    documents: plan.conversion.documents.length, findings: plan.conversion.findings }))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await upgradeKernelCli(process.argv.slice(2))
