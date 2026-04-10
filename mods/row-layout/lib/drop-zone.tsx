import { useDroppable } from '@dnd-kit/core'

export function DropZone({ id, active }: { id: string; active?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id })

  if (!active) return null

  return (
    <div
      ref={setNodeRef}
      className={`h-8 -my-4 rounded border-2 border-dashed transition-colors ${
        isOver ? 'border-primary bg-primary/20' : 'border-[--border]'
      }`}
    />
  )
}
