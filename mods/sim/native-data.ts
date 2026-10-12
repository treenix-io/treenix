import { getComponent, getComponentField } from '@treenx/core';
import type { Class } from '@treenx/core/comp';
import { KernelError } from '@treenx/core/errors';
import type { Node, Reader, WriteActionContext } from '@treenx/core/kernel/types';
import { SimDescriptive, SimPosition } from './types';

/** Require the component specified by the simulation entity contract. */
export function part<T extends object>(node: Node, cls: Class<T>): T {
  const value = getComponent(node, cls);
  if (value === undefined)
    throw new KernelError('INVALID', `Simulation component absent: ${node.$path}`);
  return value;
}

/** Patch the actual component key, including compositions authored outside the seed. */
export function patchPart<T extends object>(
  ctx: WriteActionContext,
  node: Node,
  cls: Class<T>,
  fields: Partial<T>,
): void {
  const entry = getComponentField(node, cls);
  if (entry === undefined) throw new KernelError('INVALID', 'Simulation component key absent');
  const [component, key] = entry;
  ctx.change.patch(node.$path, {
    $set: key === '' ? fields : { [key]: { ...component, ...fields } },
  });
}

/** Read the caller's current projection and propagate refusals. */
export async function readNode(reader: Reader, path: string): Promise<Node> {
  const copy = (await reader.read({ node: path })).copies[0];
  if ('error' in copy) throw copy.error;
  return copy.node;
}

/** Keep display names compatible with entities that only compose a position. */
export function entityName(node: Node): string {
  return getComponent(node, SimDescriptive)?.name ?? node.$path.split('/').at(-1)!;
}

/** Select spatial participants; lacking a position means an entity is outside the map. */
export function nearby(agent: Node, entities: readonly Node[]): Node[] {
  const position = part(agent, SimPosition);
  return entities.filter((other) => {
    if (agent.$path === other.$path) return false;
    const target = getComponent(other, SimPosition);
    return (
      target !== undefined &&
      Math.hypot(position.x - target.x, position.y - target.y) <= position.radius
    );
  });
}
