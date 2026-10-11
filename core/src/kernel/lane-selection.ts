import type { NodeLaneImage } from '#kernel/lane';
import type { ReadSet } from '#kernel/preconditions';
import type { ScanKey } from '#kernel/store/scan';
import type { ComputedNode, Cursor, ErrorCopy, NodeId, Path, Position, Row, Sort, SubSelector, ViewOwner } from '#kernel/types';

export interface LaneBranch {
  readonly covered: readonly NodeId[];
  readonly reads: ReadSet;
  readonly computed?: readonly NodeId[];
  readonly viewErrors?: readonly NodeId[];
}

export interface LaneRoot extends LaneBranch {
  readonly path: Path;
  readonly member?: { readonly id: NodeId; readonly key: ScanKey };
}

export interface LaneSelection {
  readonly viewOwner?: ViewOwner;
  readonly roots: readonly LaneRoot[];
  readonly fixedIncludes: LaneBranch;
  readonly images: readonly NodeLaneImage[];
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

export interface LaneSelectionSource {
  select(
    selector: SubSelector,
    candidates?: readonly Path[],
    range?: LaneRange,
  ): Promise<LaneSelection>;
  key(path: Path, sort: Sort): Promise<ScanKey | null>;
  cursor(selector: SubSelector, key: ScanKey): Cursor;
}
