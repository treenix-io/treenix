import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { KernelError } from '#errors'
import type { Position } from '#kernel/types'
import { scanBudget } from './contract'
import { scanFsNodes } from './fs-layout'

const position: Position = { instance: 'physical-probe', epoch: 1, seq: 1 }

/** Preserve each real filesystem boundary fixture in its owned project scratch directory. */
async function scratch(): Promise<string> {
  const parent = fileURLToPath(
    new URL('../../../../../temp/fs-optional-probe/', import.meta.url),
  )
  await mkdir(parent, { recursive: true })
  return mkdtemp(join(parent, 'dataset-'))
}

it('reads newly present optional bodies freshly and refuses dangling body symlinks', async () => {
  for (const name of ['$', '$.json']) {
    const directory = await scratch(),
      outside = await scratch()
    await mkdir(join(directory, 'doc'))
    const file = join(directory, 'doc', name)
    const absent = await scanFsNodes(
      directory,
      position,
      { node: '/doc' },
      scanBudget(),
      true,
    )
    assert.deepEqual(absent.nodes, [])

    for (const value of [1, 2]) {
      const body = JSON.stringify({ $type: 't.dir', value })
      await writeFile(file, body)
      const present = await scanFsNodes(
        directory,
        position,
        { node: '/doc' },
        scanBudget(),
        true,
      )
      assert.deepEqual(
        present.nodes.map((node) => [node.$path, node.value]),
        [['/doc', value]],
      )
      assert.equal(present.cost.nodes, 1)
      assert.equal(present.cost.bytes, Buffer.byteLength(body))
    }

    await unlink(file)
    await symlink(join(outside, 'absent'), file)
    await assert.rejects(
      scanFsNodes(directory, position, { node: '/doc' }, scanBudget(), true),
      (error) => error instanceof KernelError && error.code === 'FORBIDDEN',
    )

    await symlink(outside, join(directory, 'escaped'), 'dir')
    await assert.rejects(
      scanFsNodes(
        directory,
        position,
        { node: '/escaped' },
        scanBudget(),
        true,
      ),
      (error) => error instanceof KernelError && error.code === 'FORBIDDEN',
    )
  }
})
