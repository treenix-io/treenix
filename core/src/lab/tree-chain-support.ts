import { isRef, type Ref } from '#core';

type Primitive = undefined | null | boolean | string | number | symbol | bigint | void;

type ValuePromise<T> = T extends Primitive
  ? Promise<T>
  : T extends Promise<any>
    ? T
    : Chain<T>;

export type Chain<T> = Promise<T> & {
  [K in keyof T]: T[K] extends TypedRef<infer U>
    ? Chain<U>
    : T[K] extends (...args: infer A) => infer R
      ? (...args: A) => ValuePromise<Awaited<NonNullable<R>>>
      : ValuePromise<Awaited<NonNullable<T[K]>>>;
};

export interface TypedRef<_T> {
  readonly $type: 'ref';
  $ref: string;
}

export function refVal<T>(Comp: (new () => T) & { $type?: string }, defaultPath = ''): TypedRef<T> {
  void Comp;
  return { $type: 'ref', $ref: defaultPath };
}

export async function runPathWithRefs(
  target: any,
  path: Array<string | unknown[]>,
  resolveRef: (ref: Ref) => Promise<any>,
): Promise<any> {
  let current = target;
  let receiver = target;
  for (const step of path) {
    if (current == null) throw new Error(`null at step: ${JSON.stringify(step)}`);
    if (typeof step === 'string') {
      receiver = current;
      current = current[step];
      if (isRef(current)) current = await resolveRef(current);
    } else {
      current = current.apply(receiver, step as any[]);
    }
    if (current?.then) current = await current;
  }
  return current;
}
