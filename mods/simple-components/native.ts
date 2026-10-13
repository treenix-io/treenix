import { KernelError } from '@treenx/core/errors';
import { type WriteActionContext } from '@treenx/core/kernel';
import { nativeSchemaModule } from '#native-module';
import type { ModuleManifest } from '@treenx/core/kernel/types';
import type { TypeSchema } from '@treenx/core/schema/types';
import descriptionSchemaJson from './schemas/t.description.json';
import checklistSchemaJson from './schemas/simple.checklist.json';
import commentsSchemaJson from './schemas/simple.comments.json';
import estimateSchemaJson from './schemas/simple.estimate.json';
import linksSchemaJson from './schemas/simple.links.json';
import tagsSchemaJson from './schemas/simple.tags.json';
import timeTrackSchemaJson from './schemas/simple.time-track.json';
import type {
  TChecklist,
  TComments,
  TEstimate,
  TLinks,
  TTags,
  TTimeTrack,
} from './types';

const checklistSchema: TypeSchema = { ...checklistSchemaJson, type: 'object' };
const commentsSchema: TypeSchema = { ...commentsSchemaJson, type: 'object' };
const estimateSchema: TypeSchema = { ...estimateSchemaJson, type: 'object' };
const linksSchema: TypeSchema = { ...linksSchemaJson, type: 'object' };
const tagsSchema: TypeSchema = { ...tagsSchemaJson, type: 'object' };
const timeTrackSchema: TypeSchema = { ...timeTrackSchemaJson, type: 'object' };

const { name: _checklistAddName, ...checklistAddArgs } = checklistSchemaJson.methods.add.arguments[0];
const { name: _checklistToggleName, ...checklistToggleArgs } = checklistSchemaJson.methods.toggle.arguments[0];
const { name: _checklistRemoveName, ...checklistRemoveArgs } = checklistSchemaJson.methods.remove.arguments[0];
const { name: _commentsAddName, ...commentsAddArgs } = commentsSchemaJson.methods.add.arguments[0];
const { name: _estimateUpdateName, ...estimateUpdateArgs } = estimateSchemaJson.methods.update.arguments[0];
const { name: _linksAddName, ...linksAddArgs } = linksSchemaJson.methods.add.arguments[0];
const { name: _linksRemoveName, ...linksRemoveArgs } = linksSchemaJson.methods.remove.arguments[0];
const { name: _tagsAddName, ...tagsAddArgs } = tagsSchemaJson.methods.add.arguments[0];
const { name: _tagsRemoveName, ...tagsRemoveArgs } = tagsSchemaJson.methods.remove.arguments[0];

/** Own the existing attachable schemas and native actions without registration capture. */
export function nativeSimpleComponentsManifest(): ModuleManifest {
  return nativeSchemaModule('@treenx/mods/simple-components', [
    { name: 't.description', security: 'ordinary', schema: { ...descriptionSchemaJson, type: 'object' }, methods: [], actions: {  } },
    { name: 'simple.checklist', security: 'ordinary', schema: checklistSchema, methods: [], actions: { add: {
    kind: 'write',
    args: { ...checklistAddArgs, type: 'object' },
    handler: checklistAdd,
  }, toggle: {
    kind: 'write',
    args: { ...checklistToggleArgs, type: 'object' },
    handler: checklistToggle,
  }, remove: {
    kind: 'write',
    args: { ...checklistRemoveArgs, type: 'object' },
    handler: checklistRemove,
  } } },
    { name: 'simple.comments', security: 'ordinary', schema: commentsSchema, methods: [], actions: { add: {
    kind: 'write',
    args: { ...commentsAddArgs, type: 'object' },
    handler: commentsAdd,
  } } },
    { name: 'simple.estimate', security: 'ordinary', schema: estimateSchema, methods: [], actions: { update: {
    kind: 'write',
    args: { ...estimateUpdateArgs, type: 'object' },
    handler: estimateUpdate,
  } } },
    { name: 'simple.links', security: 'ordinary', schema: linksSchema, methods: [], actions: { add: {
    kind: 'write',
    args: { ...linksAddArgs, type: 'object' },
    handler: linksAdd,
  }, remove: {
    kind: 'write',
    args: { ...linksRemoveArgs, type: 'object' },
    handler: linksRemove,
  } } },
    { name: 'simple.tags', security: 'ordinary', schema: tagsSchema, methods: [], actions: { add: {
    kind: 'write',
    args: { ...tagsAddArgs, type: 'object' },
    handler: tagsAdd,
  }, remove: {
    kind: 'write',
    args: { ...tagsRemoveArgs, type: 'object' },
    handler: tagsRemove,
  } } },
    { name: 'simple.time-track', security: 'ordinary', schema: timeTrackSchema, methods: [], actions: { start: {
    kind: 'write',
    args: {},
    handler: timeTrackStart,
  }, stop: {
    kind: 'write',
    args: {},
    handler: timeTrackStop,
  } } },
  ]);
}

/** Decodes one JSON object supplied at the external action boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordArgs(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new KernelError('INVALID', 'Action arguments must be an object');
  return value;
}

/** Reads a required string from validated action input. */
function requiredString(value: unknown, field: string): string {
  const args = recordArgs(value);
  const fieldValue = args[field];
  if (typeof fieldValue !== 'string') throw new KernelError('INVALID', `Action argument ${field} must be a string`);
  return fieldValue;
}

/** Reads an optional string while preserving its absent state. */
function optionalString(value: unknown, field: string): string | undefined {
  const args = recordArgs(value);
  const fieldValue = args[field];
  if (fieldValue === undefined) return undefined;
  if (typeof fieldValue !== 'string') throw new KernelError('INVALID', `Action argument ${field} must be a string`);
  return fieldValue;
}

/** Reads a required number from validated action input. */
function requiredNumber(value: unknown, field: string): number {
  const args = recordArgs(value);
  const fieldValue = args[field];
  if (typeof fieldValue !== 'number') throw new KernelError('INVALID', `Action argument ${field} must be a number`);
  return fieldValue;
}

/** Reads the numeric id shared by checklist and link actions. */
function requiredId(value: unknown): number {
  return requiredNumber(value, 'id');
}

/** Add a trimmed incomplete checklist item with the next available integer id. */
async function checklistAdd(this: TChecklist, _ctx: WriteActionContext, args: unknown): Promise<void> {
  const text = requiredString(args, 'text').trim();
  if (text.length === 0) throw new KernelError('INVALID', 'Checklist text is required');

  const id = this.items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
  this.items.push({ id, text, done: false });
}

/** Toggle the selected checklist item while keeping its text. */
async function checklistToggle(this: TChecklist, _ctx: WriteActionContext, args: unknown): Promise<void> {
  const id = requiredId(args);
  const item = this.items.find(candidate => candidate.id === id);
  if (item === undefined) throw new KernelError('NOT_FOUND', 'Checklist item does not exist');

  item.done = !item.done;
}

/** Remove the selected checklist item. */
async function checklistRemove(this: TChecklist, _ctx: WriteActionContext, args: unknown): Promise<void> {
  const id = requiredId(args);
  const index = this.items.findIndex(item => item.id === id);
  if (index < 0) throw new KernelError('NOT_FOUND', 'Checklist item does not exist');

  this.items.splice(index, 1);
}

/** Append a timestamped comment, using the existing anonymous-author default. */
async function commentsAdd(this: TComments, _ctx: WriteActionContext, args: unknown): Promise<void> {
  const text = requiredString(args, 'text').trim();
  if (text.length === 0) throw new KernelError('INVALID', 'Comment text is required');

  const author = optionalString(args, 'author')?.trim() || 'anonymous';
  this.items.push({ author, text, createdAt: Date.now() });
}

/** Update an estimate value and retain its unit when no new unit is supplied. */
async function estimateUpdate(this: TEstimate, _ctx: WriteActionContext, args: unknown): Promise<void> {
  const value = requiredNumber(args, 'value');
  if (value < 0) throw new KernelError('INVALID', 'Estimate value must be nonnegative');

  const unit = optionalString(args, 'unit');
  if (unit !== undefined) {
    if (unit !== 'hours' && unit !== 'points' && unit !== 'days')
      throw new KernelError('INVALID', 'Estimate unit is invalid');
    this.unit = unit;
  }
  this.value = value;
}

/** Append a trimmed URL and optional label with the next available integer id. */
async function linksAdd(this: TLinks, _ctx: WriteActionContext, args: unknown): Promise<void> {
  const url = requiredString(args, 'url').trim();
  if (url.length === 0) throw new KernelError('INVALID', 'Link URL is required');

  const id = this.items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
  const label = optionalString(args, 'label')?.trim() || '';
  this.items.push({ id, url, label });
}

/** Remove the selected link. */
async function linksRemove(this: TLinks, _ctx: WriteActionContext, args: unknown): Promise<void> {
  const id = requiredId(args);
  const index = this.items.findIndex(item => item.id === id);
  if (index < 0) throw new KernelError('NOT_FOUND', 'Link does not exist');

  this.items.splice(index, 1);
}

/** Add one trimmed tag unless it is already present. */
async function tagsAdd(this: TTags, _ctx: WriteActionContext, args: unknown): Promise<void> {
  const tag = requiredString(args, 'tag').trim();
  if (tag.length === 0) throw new KernelError('INVALID', 'Tag name is required');
  if (this.items.includes(tag)) return;

  this.items.push(tag);
}

/** Remove a tag when present; a missing tag remains a successful no-op. */
async function tagsRemove(this: TTags, _ctx: WriteActionContext, args: unknown): Promise<void> {
  const index = this.items.indexOf(requiredString(args, 'tag'));
  if (index >= 0) this.items.splice(index, 1);
}

/** Start a timer and append its open entry. */
async function timeTrackStart(this: TTimeTrack, _ctx: WriteActionContext, _args: unknown): Promise<void> {
  if (this.running) throw new KernelError('CONFLICT', 'Timer is already running');

  this.entries.push({ start: Date.now(), end: 0 });
  this.running = true;
}

/** Close the active timer entry and clear the running state. */
async function timeTrackStop(this: TTimeTrack, _ctx: WriteActionContext, _args: unknown): Promise<void> {
  if (!this.running) throw new KernelError('CONFLICT', 'Timer is not running');

  const entry = this.entries[this.entries.length - 1];
  if (entry === undefined) throw new KernelError('INVALID', 'Running timer has no open entry');
  entry.end = Date.now();
  this.running = false;
}
