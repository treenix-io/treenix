// Board task — universal task management, dogfooded inside Treenity

import { registerType } from '@treenity/core/comp';

/** Task card — status-driven workflow with assignment and priority */
export class BoardTask {
  title = '';
  /** @format textarea */
  description = '';
  status = 'backlog';
  assignee = '';
  priority: 'low' | 'normal' | 'high' | 'urgent' = 'normal';
  /** @format textarea */
  result = '';
  createdAt = 0;
  updatedAt = 0;

  /** @description Assign task to a person or AI, moves to todo */
  assign(data: { /** Assignee name or 'ai' for AI agent */ to: string }) {
    if (!data.to?.trim()) throw new Error('assignee required');
    this.assignee = data.to.trim();
    this.status = 'todo';
    this.updatedAt = Date.now();
  }

  /** @description Start working on this task */
  start() {
    if (this.status !== 'todo' && this.status !== 'backlog')
      throw new Error(`cannot start from "${this.status}"`);
    this.status = 'doing';
    this.updatedAt = Date.now();
  }

  /** @description Submit task for review */
  submit(data?: { /** Result notes */ result?: string }) {
    if (this.status !== 'doing') throw new Error(`cannot submit from "${this.status}"`);
    if (data?.result) this.result = data.result;
    this.status = 'review';
    this.updatedAt = Date.now();
  }

  /** @description Approve task — mark as done */
  approve() {
    if (this.status !== 'review') throw new Error(`cannot approve from "${this.status}"`);
    this.status = 'done';
    this.updatedAt = Date.now();
  }

  /** @description Reject task — send back to doing */
  reject(data?: { /** Reason for rejection */ reason?: string }) {
    if (this.status !== 'review') throw new Error(`cannot reject from "${this.status}"`);
    if (data?.reason) this.result = `Rejected: ${data.reason}`;
    this.status = 'doing';
    this.updatedAt = Date.now();
  }

  /** @description Move task to any status (kanban DnD) */
  move(data: { /** Target */ status: string }) {
    if (this.status === data.status) return;
    this.status = data.status;
    this.updatedAt = Date.now();
  }

  /** @description Reopen task — reset to backlog */
  reopen() {
    this.status = 'backlog';
    this.assignee = '';
    this.result = '';
    this.updatedAt = Date.now();
  }
}

registerType('board.task', BoardTask);

/** Kanban board — container node, columns are children */
export class BoardKanban {}

registerType('board.kanban', BoardKanban);

/** Kanban column — label + color + sort order. Query mount provides filtered tasks. */
export class BoardColumn {
  label = '';
  color = 'border-zinc-400';
  order = 0;
}

registerType('board.column', BoardColumn);
