// Universal ECS components — attach to any node via named key
// Pattern: node.checklist = { $type: 'simple.checklist', items: [...] }

import { registerType } from '@treenx/core/comp';

// ── Checklist ──

export class TChecklist {
  items: { id: number; text: string; done: boolean }[] = [];

  /** @description Add a checklist item */
  add(data: { /** Item text */ text: string }) {
    if (!data.text?.trim()) throw new Error('text required');
    const id = this.items.reduce((max, i) => Math.max(max, i.id), 0) + 1;
    this.items.push({ id, text: data.text.trim(), done: false });
  }

  /** @description Toggle checklist item */
  async toggle(data: { /** Item id */ id: number }) {
    const item = this.items.find(i => i.id === data.id);
    if (!item) throw new Error('invalid id');
    item.done = !item.done;
  }

  /** @description Remove checklist item */
  remove(data: { /** Item id */ id: number }) {
    const idx = this.items.findIndex(i => i.id === data.id);
    if (idx < 0) throw new Error('invalid id');
    this.items.splice(idx, 1);
  }
}

registerType('simple.checklist', TChecklist);

// ── Tags ──

export class TTags {
  items: string[] = [];

  /** @description Add a tag */
  add(data: { /** Tag name */ tag: string }) {
    const tag = data.tag?.trim();
    if (!tag) throw new Error('tag required');
    if (this.items.includes(tag)) return;
    this.items.push(tag);
  }

  /** @description Remove a tag */
  remove(data: { /** Tag name */ tag: string }) {
    const idx = this.items.indexOf(data.tag);
    if (idx >= 0) this.items.splice(idx, 1);
  }
}

registerType('simple.tags', TTags);

// ── Estimate ──

export class TEstimate {
  value = 0;
  unit: 'hours' | 'points' | 'days' = 'hours';

  /** @description Set estimate value and unit */
  update(data: { /** Numeric value */ value: number; /** Unit */ unit?: 'hours' | 'points' | 'days' }) {
    if (typeof data.value !== 'number' || data.value < 0) throw new Error('value must be >= 0');
    this.value = data.value;
    if (data.unit) this.unit = data.unit;
  }
}

registerType('simple.estimate', TEstimate);

// ── Links ──

export class TLinks {
  items: { id: number; url: string; label: string }[] = [];

  /** @description Add a link */
  add(data: { /** URL */ url: string; /** Display label */ label?: string }) {
    if (!data.url?.trim()) throw new Error('url required');
    const id = this.items.reduce((max, i) => Math.max(max, i.id), 0) + 1;
    this.items.push({ id, url: data.url.trim(), label: data.label?.trim() || '' });
  }

  /** @description Remove a link by id */
  remove(data: { /** Item id */ id: number }) {
    const idx = this.items.findIndex(i => i.id === data.id);
    if (idx < 0) throw new Error('invalid id');
    this.items.splice(idx, 1);
  }
}

registerType('simple.links', TLinks);

// ── Comments ──

export class TComments {
  items: { author: string; text: string; createdAt: number }[] = [];

  /** @description Add a comment */
  add(data: { /** Comment text */ text: string; /** Author name */ author?: string }) {
    if (!data.text?.trim()) throw new Error('text required');
    this.items.push({
      author: data.author?.trim() || 'anonymous',
      text: data.text.trim(),
      createdAt: Date.now(),
    });
  }
}

registerType('simple.comments', TComments);

// ── Time Track ──

export class TTimeTrack {
  entries: { start: number; end: number }[] = [];
  running = false;

  /** @description Start the timer */
  start() {
    if (this.running) throw new Error('already running');
    this.entries.push({ start: Date.now(), end: 0 });
    this.running = true;
  }

  /** @description Stop the timer */
  stop() {
    if (!this.running) throw new Error('not running');
    const last = this.entries[this.entries.length - 1];
    if (last) last.end = Date.now();
    this.running = false;
  }
}

registerType('simple.time-track', TTimeTrack);

// ── Attachable component registry ──

export interface AttachableComponent {
  type: string;
  key: string;
  label: string;
  description: string;
  icon: string;
  defaults: Record<string, unknown>;
}

export const ATTACHABLE_COMPONENTS: AttachableComponent[] = [
  { type: 'simple.checklist', key: 'checklist', label: 'Checklist', description: 'Todo items with progress tracking', icon: '☑', defaults: { items: [] } },
  { type: 'simple.tags', key: 'tags', label: 'Tags', description: 'Colored labels for categorization', icon: '🏷', defaults: { items: [] } },
  { type: 'simple.estimate', key: 'estimate', label: 'Estimate', description: 'Time or effort estimation', icon: '⏱', defaults: { value: 0, unit: 'hours' } },
  { type: 'simple.links', key: 'links', label: 'Links', description: 'Related URLs and references', icon: '🔗', defaults: { items: [] } },
  { type: 'simple.comments', key: 'comments', label: 'Comments', description: 'Discussion thread', icon: '💬', defaults: { items: [] } },
  { type: 'simple.time-track', key: 'timeTrack', label: 'Time Track', description: 'Start/stop timer with history', icon: '⏲', defaults: { entries: [], running: false } },
];
