import type { NodeLaneImage } from '#kernel/lane';
import type { ReadSet } from '#kernel/preconditions';
import type { ScanKey } from '#kernel/store/scan';
import type { Cursor, NodeId, Path, Sort, SubSelector } from '#kernel/types';

export interface LaneBranch {
  readonly covered: readonly NodeId[];
  readonly reads: ReadSet;
}

export interface LaneRoot extends LaneBranch {
  readonly path: Path;
  readonly member?: { readonly id: NodeId; readonly key: ScanKey };
}

export interface LaneSelection {
  readonly roots: readonly LaneRoot[];
  readonly fixedIncludes: LaneBranch;
  readonly images: readonly NodeLaneImage[];
  readonly reads: ReadSet;
  readonly next?: Cursor;
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
