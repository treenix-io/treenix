import type { OperationReadCost } from '#kernel/store/budget';
import type { NodeLaneImage } from '#kernel/lane';
import type { ReadSet } from '#kernel/preconditions';
import type { ScanKey } from '#kernel/store/scan';
import type { ComputedNode,Cursor,ErrorCopy,NodeId,Path,Position,Row,Sort,SubSelector,ViewOwner,ScanRange,LaneOwnership } from '#kernel/types';

export interface LaneBranch {
  readonly covered: readonly NodeId[];
  readonly reads: ReadSet;
  readonly computed?: readonly NodeId[];
  readonly viewErrors?: readonly NodeId[];
}

export interface LaneRoot extends LaneBranch {
  readonly path: Path;
  readonly member?: { readonly id: NodeId; readonly key: ScanKey; readonly query?: Readonly<Record<string, unknown>> };
}

export type LaneDeliveryImage = Pick<NodeLaneImage, 'copy' | 'before' | 'bytes' | 'position' | 'retain'>;

export interface LaneSelection<Image extends LaneDeliveryImage = NodeLaneImage> {
  readonly viewOwner?: ViewOwner;
  readonly roots: readonly LaneRoot[];
  readonly fixedIncludes: LaneBranch;
  readonly images: readonly Image[];
  readonly reads: ReadSet;
  readonly next?: Cursor;
  readonly computed?: readonly ComputedNode[];
  readonly viewErrors?: readonly ErrorCopy[];
  readonly rows?: readonly Row[];
  readonly at?: readonly Position[];
}

export interface LaneRange {
  readonly upper?: ScanKey | null;
}

/** Exposes exact selected branch ownership and its producer's continuation. */
export function selectionOwnership(selection: LaneSelection<LaneDeliveryImage>, cursor: (key: ScanKey) => Cursor): LaneOwnership {
  const covered = (branch: LaneBranch) => [...branch.covered, ...branch.computed ?? [], ...branch.viewErrors ?? []];
  return { fixed: covered(selection.fixedIncludes), roots: selection.roots.flatMap(root => root.member === undefined ? []
    : [{ id: root.member.id, covered: covered(root), cursor: cursor(root.member.key), query: root.member.query }]) };
}

export interface LaneSelectionSource {
  select(
    selector: SubSelector,
    candidates?: readonly Path[],
    range?: LaneRange,
  ): Promise<LaneSelection>;
  key(path: Path, sort: Sort): Promise<ScanKey | null>;
  cursor(selector: SubSelector, key: ScanKey): Cursor;
}


export interface LaneProjection<Image extends LaneDeliveryImage = LaneDeliveryImage> {
  readonly key: string;
  readonly version: number;
  readonly ready: boolean;
  intersects(test: (range: ScanRange) => boolean): boolean;
  invalidate(): void;
  cursor(key: ScanKey): string;
  select(range?: LaneRange): LaneSelection<Image> | undefined;
  close(): void;
  readonly authority?: {
    validate(cost: OperationReadCost): Promise<void>;
    check(): void;
    image(path: Path, sort: Sort): LaneDeliveryImage | null;
  };
}
