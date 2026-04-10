import { registerType } from '@treenity/core/comp'
import { templates } from './lib/templates'
import type { LayoutRow } from './lib/types'

export class RowColLayout {
  gap = 'gap-3'
  padding = 'p-4'
  context = 'react'
  rows: LayoutRow[] = []
  hidden: string[] = []

  applyTemplate(data: { name: string; refs: string[] }) {
    const tpl = templates.find(t => t.name === data.name)
    if (!tpl) throw new Error(`Unknown template: ${data.name}`)
    this.rows = tpl.apply(data.refs)
    this.hidden = []
  }
}

registerType('layout.row-col', RowColLayout)
