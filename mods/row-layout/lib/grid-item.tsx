import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@treenity/react/ui/dropdown-menu'
import { EllipsisVertical } from 'lucide-react'
import type { ReactNode } from 'react'
import { isComponentRef, type LayoutItem } from './types'

const PADDINGS = [
  { label: 'None', value: '' },
  { label: 'Small', value: 'p-2' },
  { label: 'Medium', value: 'p-4' },
  { label: 'Large', value: 'p-6' },
] as const

type GridItemProps = {
  item: LayoutItem
  editable?: boolean
  children: ReactNode
  onUpdate?: (patch: Partial<LayoutItem>) => void
  onHide?: () => void
  onRemove?: () => void
  isCrossRow?: boolean
  extraMenu?: ReactNode
  prependMenu?: ReactNode
}

export function GridItem({ item, editable, children, onUpdate, onHide, onRemove, isCrossRow, extraMenu, prependMenu }: GridItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.ref,
  })

  const dragProps = editable ? { ...attributes, ...listeners } : {}

  return (
    <div
      ref={setNodeRef}
      {...dragProps}
      className={`relative group min-h-[40px] rounded-md ${item.padding ?? ''} ${editable ? 'cursor-grab outline outline-1 outline-dashed outline-[--border]' : ''} ${isDragging ? 'opacity-30' : ''}`}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      {isCrossRow && (
        <div className="absolute -left-1 top-0 bottom-0 flex items-center z-10">
          <div className="w-0.5 h-full bg-primary rounded-full" />
        </div>
      )}

      {editable && (
        <div
          className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-20"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-0.5 rounded hover:bg-[--card] text-[--text-3]">
                <EllipsisVertical className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-36">
              {prependMenu}

              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="text-xs">Padding</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {PADDINGS.map(p => (
                    <DropdownMenuItem
                      key={p.value}
                      className={`text-xs ${item.padding === p.value ? 'font-bold' : ''}`}
                      onSelect={() => onUpdate?.({ padding: p.value || undefined })}
                    >
                      {p.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              <DropdownMenuSeparator />

              {isComponentRef(item.ref) && (
                <DropdownMenuItem className="text-xs" onSelect={onHide}>
                  Hide
                </DropdownMenuItem>
              )}

              {!isComponentRef(item.ref) && (
                <DropdownMenuItem className="text-xs text-destructive" onSelect={onRemove ?? onHide}>
                  Remove
                </DropdownMenuItem>
              )}

              {extraMenu && (
                <>
                  <DropdownMenuSeparator />
                  {extraMenu}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {children}
    </div>
  )
}
