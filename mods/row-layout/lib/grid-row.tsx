import { horizontalListSortingStrategy, SortableContext } from '@dnd-kit/sortable'
import type { ReactNode } from 'react'
import type { LayoutItem, LayoutRow as LayoutRowType } from './types'

type GridRowProps = {
  row: LayoutRowType
  editable?: boolean
  renderItem: (item: LayoutItem, isCrossRow: boolean) => ReactNode
  activeRowId?: string | null
}

export function GridRow({ row, editable, renderItem, activeRowId }: GridRowProps) {
  const gridCols = row.grid ?? `repeat(${row.items.length}, 1fr)`
  const isCrossRow = activeRowId !== null && activeRowId !== row.id

  return (
    <SortableContext items={row.items.map(i => i.ref)} strategy={horizontalListSortingStrategy}>
      <div
        className={`grid ${row.gap ?? 'gap-3'} ${editable ? 'outline outline-1 outline-dashed outline-[--border] rounded' : ''}`}
        style={{ gridTemplateColumns: gridCols }}
      >
        {row.items.map(item => renderItem(item, isCrossRow))}
      </div>
    </SortableContext>
  )
}
