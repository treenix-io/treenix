import {
  closestCenter, DndContext, DragOverlay,
  PointerSensor, pointerWithin, useSensor, useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@treenity/react/ui/dropdown-menu'
import { GripVertical, LayoutGrid } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { DropZone } from './drop-zone'
import { GridItem } from './grid-item'
import { GridRow } from './grid-row'
import { templates } from './templates'
import { isComponentRef, type LayoutItem, type LayoutRow, type RowColGridProps } from './types'

function findItem(rows: LayoutRow[], ref: string) {
  for (let ri = 0; ri < rows.length; ri++) {
    const ii = rows[ri].items.findIndex(i => i.ref === ref)
    if (ii !== -1) return { rowIdx: ri, itemIdx: ii, rowId: rows[ri].id }
  }
  return null
}

function zoneAwareCollision(args: Parameters<typeof closestCenter>[0]) {
  const zones = args.droppableContainers.filter(c => String(c.id).startsWith('zone-'))
  if (zones.length) {
    const zoneHits = pointerWithin({ ...args, droppableContainers: zones })
    if (zoneHits.length) return zoneHits
  }
  const items = args.droppableContainers.filter(c => !String(c.id).startsWith('zone-'))
  return closestCenter({ ...args, droppableContainers: items })
}

let _counter = 0
const rid = () => `r${Date.now().toString(36)}${(_counter++).toString(36)}`

const GRID_PRESETS = [
  { label: 'Equal', value: undefined },
  { label: '2:1', value: '2fr 1fr' },
  { label: '1:2', value: '1fr 2fr' },
  { label: '1:1:1', value: '1fr 1fr 1fr' },
  { label: 'Sidebar', value: '280px 1fr' },
] as const

const GAPS = [
  { label: 'None', value: 'gap-0' },
  { label: 'Small', value: 'gap-1' },
  { label: 'Medium', value: 'gap-3' },
  { label: 'Large', value: 'gap-6' },
] as const

const PADDINGS = [
  { label: 'None', value: '' },
  { label: 'Small', value: 'p-2' },
  { label: 'Medium', value: 'p-4' },
  { label: 'Large', value: 'p-6' },
] as const

// ── Row menu ──

function makeRowMenuHandlers(
  row: LayoutRow, rowIdx: number, rows: LayoutRow[], hidden: string[],
  onChange: RowColGridProps['onChange'],
) {
  function setGrid(grid: string | undefined) {
    const newRows = rows.map((r, i) => i === rowIdx ? { ...r, grid } : r)
    onChange?.({ rows: newRows })
  }

  function setRowGap(gap: string | undefined) {
    const newRows = rows.map((r, i) => i === rowIdx ? { ...r, gap } : r)
    onChange?.({ rows: newRows })
  }

  function deleteRow() {
    const hiddenRefs = row.items.filter(i => isComponentRef(i.ref)).map(i => i.ref)
    const newRows = rows.filter((_, i) => i !== rowIdx)
    const patch: Record<string, unknown> = { rows: newRows }
    if (hiddenRefs.length) patch.hidden = [...hidden, ...hiddenRefs]
    onChange?.(patch)
  }

  return { setGrid, setRowGap, deleteRow }
}

function RowMenuItems({ row, onSetGrid, onSetGap, onDelete }: {
  row: LayoutRow
  onSetGrid: (grid: string | undefined) => void
  onSetGap: (gap: string | undefined) => void
  onDelete: () => void
}) {
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="text-xs">Grid columns</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {GRID_PRESETS.map(p => (
            <DropdownMenuItem
              key={p.label}
              className={`text-xs ${row.grid === p.value ? 'font-bold' : ''}`}
              onSelect={() => onSetGrid(p.value)}
            >
              {p.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="text-xs">Row gap</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {GAPS.map(g => (
            <DropdownMenuItem
              key={g.value}
              className={`text-xs ${row.gap === g.value ? 'font-bold' : ''}`}
              onSelect={() => onSetGap(g.value === 'gap-3' ? undefined : g.value)}
            >
              {g.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSeparator />

      <DropdownMenuItem className="text-xs text-destructive" onSelect={onDelete}>
        Delete row
      </DropdownMenuItem>
    </>
  )
}

function InlineRowMenuItems({ row, rowIdx, rows, hidden, onChange }: {
  row: LayoutRow
  rowIdx: number
  rows: LayoutRow[]
  hidden: string[]
  onChange: RowColGridProps['onChange']
}) {
  const { setGrid, setRowGap, deleteRow } = makeRowMenuHandlers(row, rowIdx, rows, hidden, onChange)
  return <RowMenuItems row={row} onSetGrid={setGrid} onSetGap={setRowGap} onDelete={deleteRow} />
}

function RowMenu({ row, rowIdx, rows, hidden, onChange }: {
  row: LayoutRow
  rowIdx: number
  rows: LayoutRow[]
  hidden: string[]
  onChange: RowColGridProps['onChange']
}) {
  const { setGrid, setRowGap, deleteRow } = makeRowMenuHandlers(row, rowIdx, rows, hidden, onChange)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="absolute -right-5 top-1 p-0.5 rounded hover:bg-[--card] text-[--text-3] opacity-0 group-hover/row:opacity-100 transition-opacity z-20" title="Row settings">
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <RowMenuItems row={row} onSetGrid={setGrid} onSetGap={setRowGap} onDelete={deleteRow} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ── Global menu ──

function GlobalMenu({ rows, hidden, gap, padding, onChange, extras }: {
  rows: LayoutRow[]
  hidden: string[]
  gap?: string
  padding?: string
  onChange: RowColGridProps['onChange']
  extras?: ReactNode
}) {
  function applyTemplate(name: string) {
    const allRefs = rows.flatMap(r => r.items.map(i => i.ref))
    const tpl = templates.find(t => t.name === name)
    if (!tpl) return
    onChange?.({ rows: tpl.apply(allRefs), hidden: [] })
  }

  function unhide(ref: string) {
    const newHidden = hidden.filter(h => h !== ref)
    const newRows = [...rows, { id: rid(), items: [{ ref }] }]
    onChange?.({ rows: newRows, hidden: newHidden })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="p-1 rounded hover:bg-[--card] text-[--text-3]">
          <LayoutGrid className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-xs">Apply template</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {templates.map(t => (
              <DropdownMenuItem key={t.name} className="text-xs" onSelect={() => applyTemplate(t.name)}>
                {t.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-xs">Gap</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {GAPS.map(g => (
              <DropdownMenuItem
                key={g.value}
                className={`text-xs ${gap === g.value ? 'font-bold' : ''}`}
                onSelect={() => onChange?.({ gap: g.value })}
              >
                {g.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-xs">Padding</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {PADDINGS.map(p => (
              <DropdownMenuItem
                key={p.label}
                className={`text-xs ${padding === p.value ? 'font-bold' : ''}`}
                onSelect={() => onChange?.({ padding: p.value || undefined })}
              >
                {p.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {extras && (
          <>
            <DropdownMenuSeparator />
            {extras}
          </>
        )}

        {hidden.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="text-xs">Unhide ({hidden.length})</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {hidden.map(ref => (
                  <DropdownMenuItem key={ref} className="text-xs font-mono" onSelect={() => unhide(ref)}>
                    {ref}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ── Main ──

export function RowColGrid(props: RowColGridProps) {
  const {
    rows, hidden, gap, padding, renderItem,
    renderItemMenuExtras, renderGlobalMenuExtras,
    editable, onExitEdit, onChange,
  } = props
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  const activePos = activeId ? findItem(rows, activeId) : null
  const srcRowIsSingleton = activePos != null && rows[activePos.rowIdx].items.length === 1

  // A zone is a no-op if the src row is a singleton and the zone is adjacent to it
  // (extracting the only item into a new row at the same position).
  const isZoneActive = (zoneIdx: number) => {
    if (!activePos) return false
    if (!srcRowIsSingleton) return true
    return zoneIdx !== activePos.rowIdx && zoneIdx !== activePos.rowIdx + 1
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id))
    setOverId(null)
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) {
      setActiveId(null)
      setOverId(null)
      return
    }

    const src = findItem(rows, String(active.id))
    if (!src) { setActiveId(null); return }

    const newRows = rows.map(r => ({ ...r, items: [...r.items] }))

    const zoneMatch = String(over.id).match(/^zone-(\d+)$/)
    if (zoneMatch) {
      let zoneIdx = parseInt(zoneMatch[1])
      const [item] = newRows[src.rowIdx].items.splice(src.itemIdx, 1)
      const srcEmpty = newRows[src.rowIdx].items.length === 0
      if (srcEmpty && src.rowIdx < zoneIdx) zoneIdx--
      const cleaned = newRows.filter(r => r.items.length > 0)
      const insertIdx = Math.min(zoneIdx, cleaned.length)
      cleaned.splice(insertIdx, 0, { id: rid(), items: [item] })
      onChange?.({ rows: cleaned })
      setActiveId(null)
      setOverId(null)
      return
    }

    const dst = findItem(rows, String(over.id))
    if (!dst) { setActiveId(null); return }

    if (src.rowIdx === dst.rowIdx) {
      newRows[src.rowIdx].items = arrayMove(newRows[src.rowIdx].items, src.itemIdx, dst.itemIdx)
    } else {
      const [item] = newRows[src.rowIdx].items.splice(src.itemIdx, 1)
      newRows[dst.rowIdx].items.splice(dst.itemIdx, 0, item)
    }

    onChange?.({ rows: newRows.filter(r => r.items.length > 0) })
    setActiveId(null)
    setOverId(null)
  }

  function handleDragOver(event: { over: { id: string | number } | null }) {
    setOverId(event.over ? String(event.over.id) : null)
  }

  function handleHide(ref: string) {
    const newR = rows.map(r => ({ ...r, items: r.items.filter(i => i.ref !== ref) }))
    const patch: Partial<{ rows: LayoutRow[]; hidden: string[] }> = {
      rows: newR.filter(r => r.items.length > 0),
    }
    if (isComponentRef(ref)) {
      patch.hidden = [...(hidden ?? []), ref]
    }
    onChange?.(patch)
  }

  function handleUpdateItem(ref: string, patch: Partial<LayoutItem>) {
    const newRows = rows.map(r => ({
      ...r,
      items: r.items.map(i => i.ref === ref ? { ...i, ...patch } : i),
    }))
    onChange?.({ rows: newRows })
  }

  if (!editable) {
    return (
      <div className={`flex flex-col ${gap ?? 'gap-3'} ${padding ?? ''}`}>
        {rows.map(row => {
          const gridCols = row.grid ?? `repeat(${row.items.length}, 1fr)`
          return (
            <div key={row.id} className={`grid ${row.gap ?? 'gap-3'}`} style={{ gridTemplateColumns: gridCols }}>
              {row.items.map(item => (
                <div key={item.ref} className={item.padding ?? ''}>
                  {renderItem(item.ref)}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={zoneAwareCollision}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
    >
      <div className={`relative flex flex-col ${gap ?? 'gap-3'} ${padding ?? ''}`}>
        <div className="absolute -top-7 right-0 flex items-center gap-1 px-1 py-0.5 rounded bg-[--card] border border-[--border] text-[--text-3] z-30">
          <GlobalMenu
            rows={rows}
            hidden={hidden}
            gap={gap}
            padding={padding}
            onChange={onChange}
            extras={renderGlobalMenuExtras?.()}
          />
          {onExitEdit && (
            <button
              onClick={onExitEdit}
              className="p-1 rounded hover:bg-[--bg-1]"
              title="Exit layout edit"
            >
              {'\u2715'}
            </button>
          )}
        </div>

        <DropZone id="zone-0" active={isZoneActive(0)} />
        {rows.map((row, ri) => {
          const singleton = row.items.length === 1
          return (
            <div key={row.id} className="relative group/row">
              <GridRow
                row={row}
                editable
                activeRowId={activePos?.rowId ?? null}
                renderItem={(item, isCrossRow) => (
                  <GridItem
                    key={item.ref}
                    item={item}
                    editable
                    isCrossRow={isCrossRow && overId === item.ref}
                    onHide={() => handleHide(item.ref)}
                    onRemove={() => handleHide(item.ref)}
                    onUpdate={(patch) => handleUpdateItem(item.ref, patch)}
                    prependMenu={renderItemMenuExtras?.(item)}
                    extraMenu={singleton ? (
                      <InlineRowMenuItems
                        row={row}
                        rowIdx={ri}
                        rows={rows}
                        hidden={hidden}
                        onChange={onChange}
                      />
                    ) : undefined}
                  >
                    {renderItem(item.ref)}
                  </GridItem>
                )}
              />
              {!singleton && (
                <RowMenu row={row} rowIdx={ri} rows={rows} hidden={hidden} onChange={onChange} />
              )}
              <DropZone id={`zone-${ri + 1}`} active={isZoneActive(ri + 1)} />
            </div>
          )
        })}
      </div>

      <DragOverlay>
        {activeId && (
          <div className="rounded-md bg-[--card] border border-[--border] shadow-lg p-2 opacity-80">
            {renderItem(activeId)}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}
