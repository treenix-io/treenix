// Task type — agents create tasks, Claude (or humans) answer them
// Spatial routing: status change → node "moves" between query mount folders

import { registerType } from '@treenity/core/comp';

/** Agent task — question/answer workflow with status tracking */
export class Task {
  status: string = 'pending';
  /** @format textarea */
  question: string = '';
  from: string = '';
  /** @format textarea */
  answer: string = '';
  answeredBy: string = '';
  answeredAt: number = 0;

  /** @description Answer the task — sets status to answered */
  respond(data: { answer: string; by?: string }) {
    if (this.status !== 'pending') throw new Error(`Task already ${this.status}`);
    this.status = 'answered';
    this.answer = data.answer;
    this.answeredBy = data.by ?? 'claude';
    this.answeredAt = Date.now();
  }

  /** @description Reject the task — sets status to rejected with optional reason */
  reject(data: { reason?: string; by?: string }) {
    if (this.status !== 'pending') throw new Error(`Task already ${this.status}`);
    this.status = 'rejected';
    this.answer = data.reason ?? '';
    this.answeredBy = data.by ?? 'claude';
    this.answeredAt = Date.now();
  }
}

registerType('task', Task);
