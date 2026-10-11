import type { Collection } from 'mongodb';
import { KernelError } from '@treenx/core/errors';
import type { BackfillProgress, StoreBackfill } from '@treenx/core/kernel/types';
import { journalIdentity, journalTimeout } from '#journal-records';
import type { StoredDocument } from '#store';

export interface BackfillDocument extends BackfillProgress { readonly _id: string }
interface MetadataDocument extends Pick<StoredDocument, '_path' | '_tid' | '_pos'> {
  readonly main: { readonly _type: string; readonly _v?: number };
  readonly named: Readonly<Record<string, { readonly _type: string; readonly _v?: number }>>;
}

const projection = {
  _path: '$_path', _tid: '$_tid', _pos: '$_pos', main: { _type: '$_type', _v: '$_v' },
  named: { $arrayToObject: { $map: {
    input: { $filter: { input: { $objectToArray: '$$ROOT' }, as: 'field',
      cond: { $regexMatch: { input: '$$field.k', regex: '^#' } } } },
    as: 'field', in: { k: '$$field.k', v: {
      _type: { $getField: { field: { $literal: '$type' }, input: '$$field.v' } },
      _v: { $getField: { field: { $literal: '$v' }, input: '$$field.v' } },
    } },
  } } },
};

/** Native metadata pages never materialize ordinary component fields. */
export function createBackfill(nodes: Collection<StoredDocument>, control: Collection<BackfillDocument>,
  base: string, available: () => void, pin: () => () => Promise<void>): StoreBackfill {
  return {
    async state(type, budget) {
      available();
      if (budget.nodes < 1) throw new KernelError('BUDGET', 'Backfill state node allowance is empty');
      const release = pin();
      try {
        const selected = await control.findOne<{ readonly state: BackfillDocument | null; readonly bytes: number }>({ _id: journalIdentity({ type, base }) }, {
          projection: { _id: 0, bytes: { $bsonSize: '$$ROOT' }, state: { $cond: [{ $lte: [{ $bsonSize: '$$ROOT' }, budget.bytes] }, '$$ROOT', null] } },
          timeoutMS: journalTimeout(budget), collation: { locale: 'simple' },
        });
        if (selected === null) return { state: undefined, cost: { nodes: 1, bytes: 0, exprWork: 0 } };
        if (selected.state === null) throw new KernelError('BUDGET', 'Mongo backfill state allowance exceeded');
        const bytes = selected.bytes + Buffer.byteLength(JSON.stringify(selected.state));
        if (bytes > budget.bytes) throw new KernelError('BUDGET', 'Backfill cumulative state allowance exceeded');
        return { state: selected.state, cost: { nodes: 1, bytes, exprWork: 0 } };
      } finally { await release(); }
    },
    async page(after, budget, limit) {
      available();
      if (!Number.isSafeInteger(limit) || limit < 1) throw new KernelError('INVALID', 'Backfill page limit is invalid');
      if (budget.nodes < 1 || budget.bytes < 1) throw new KernelError('BUDGET', 'Backfill metadata allowance is empty');
      const release = pin();
      try {
        const items = [];
        let bytes = 0, last = after;
        for (let count = 0; count < Math.min(limit, budget.nodes); count++) {
          const local = last === undefined ? undefined : base === '/' ? last : last === base ? '/' : last.slice(base.length);
          const selected = await nodes.find<{ readonly image: MetadataDocument | null; readonly bytes: number }>(
            local === undefined ? {} : { _path: { $gt: local } }, {
              projection: { _id: 0, bytes: { $bsonSize: projection }, image: { $cond: [
                { $lte: [{ $bsonSize: projection }, budget.bytes - bytes] }, projection, null,
              ] } }, sort: { _path: 1 }, limit: 1, singleBatch: true,
              timeoutMS: journalTimeout(budget), collation: { locale: 'simple' },
            }).toArray();
          if (selected.length === 0) return { items, cost: { nodes: items.length, bytes, exprWork: 0 } };
          const image = selected[0].image;
          if (image === null) throw new KernelError('BUDGET', 'Mongo backfill metadata allowance exceeded');
          const path = base === '/' ? image._path : image._path === '/' ? base : `${base}${image._path}`;
          const item = { $path: path, $id: image._tid, $pos: image._pos,
            main: { $type: image.main._type, $v: image.main._v },
            named: Object.fromEntries(Object.entries(image.named).map(([key, value]) =>
              [key, { $type: value._type, $v: value._v }])) };
          bytes += selected[0].bytes + Buffer.byteLength(JSON.stringify(item));
          if (bytes > budget.bytes) throw new KernelError('BUDGET', 'Mongo backfill logical allowance exceeded');
          items.push(item);
          last = path;
        }
        return { items, cost: { nodes: items.length, bytes, exprWork: 0 }, next: last };
      } finally { await release(); }
    },
  };
}
