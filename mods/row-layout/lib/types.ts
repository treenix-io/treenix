import type { Raw } from '@treenx/core/comp'
import type { ReactNode } from 'react'
import type { RowColLayout } from '../types'

export type LayoutItem = {
  ref: string
  context?: string
  padding?: string
}

export type LayoutRow = {
  id: string
  items: LayoutItem[]
  grid?: string
  gap?: string
}

export type RowColGridProps = Raw<RowColLayout> & {
  renderItem: (ref: string) => ReactNode
  renderItemMenuExtras?: (item: LayoutItem) => ReactNode
  renderGlobalMenuExtras?: () => ReactNode
  editable?: boolean
  onExitEdit?: () => void
  onChange?: (patch: Partial<Raw<RowColLayout>>) => void
}

export const isComponentRef = (ref: string) => ref.startsWith('#')
export const componentKey = (ref: string) => ref.slice(1)
