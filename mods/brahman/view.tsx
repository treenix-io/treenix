// Brahman — view registrations
// Registers react + react:list handlers for all brahman types

import { register } from '@treenity/core/core';
import './types';

import {
  ActionListItem,
  BackEditor,
  BroadcastEditor,
  EmitTextEditor,
  EvalEditor,
  FileEditor,
  ForwardEditor,
  GetValueEditor,
  IfElseEditor,
  KeywordSelectEditor,
  MessageEditor,
  OnErrorEditor,
  PageNavEditor,
  ParamsEditor,
  QuestionEditor,
  RemoveEditor,
  ResetHistoryEditor,
  ResetSessionEditor,
  SelectLanguageEditor,
  SetValueEditor,
  TagEditor,
} from './views/action-cards';
import { BotView } from './views/bot-view';
import { PageChatEditor } from './views/chat-editor';
import { PageChatPreview } from './views/chat-preview';
import { PageLayoutView } from './views/page-layout';

// ── Node-level views (react context) ──

register('brahman.bot', 'react', BotView as any);
register('brahman.page', 'react', PageLayoutView as any);
register('brahman.page', 'react:chat', PageChatPreview as any);
register('brahman.page', 'react:chat:edit', PageChatEditor as any);
register('brahman.action.message', 'react', MessageEditor as any);
register('brahman.action.question', 'react', QuestionEditor as any);
register('brahman.action.ifelse', 'react', IfElseEditor as any);
register('brahman.action.page', 'react', PageNavEditor as any);
register('brahman.action.back', 'react', BackEditor as any);
register('brahman.action.tag', 'react', TagEditor as any);
register('brahman.action.broadcast', 'react', BroadcastEditor as any);
register('brahman.action.getvalue', 'react', GetValueEditor as any);
register('brahman.action.setvalue', 'react', SetValueEditor as any);
register('brahman.action.params', 'react', ParamsEditor as any);
register('brahman.action.file', 'react', FileEditor as any);
register('brahman.action.eval', 'react', EvalEditor as any);
register('brahman.action.remove', 'react', RemoveEditor as any);
register('brahman.action.emittext', 'react', EmitTextEditor as any);
register('brahman.action.forward', 'react', ForwardEditor as any);
register('brahman.action.resetsession', 'react', ResetSessionEditor as any);
register('brahman.action.resethistory', 'react', ResetHistoryEditor as any);
register('brahman.action.onerror', 'react', OnErrorEditor as any);
register('brahman.action.keywordselect', 'react', KeywordSelectEditor as any);
register('brahman.action.selectlang', 'react', SelectLanguageEditor as any);

// ── Compact list items (react:list context) ──

const listTypes = [
  'brahman.action.message', 'brahman.action.question', 'brahman.action.ifelse',
  'brahman.action.page', 'brahman.action.back', 'brahman.action.tag',
  'brahman.action.broadcast', 'brahman.action.getvalue', 'brahman.action.setvalue',
  'brahman.action.params', 'brahman.action.file', 'brahman.action.eval',
  'brahman.action.remove', 'brahman.action.emittext', 'brahman.action.forward',
  'brahman.action.resetsession', 'brahman.action.resethistory', 'brahman.action.onerror',
  'brahman.action.keywordselect', 'brahman.action.selectlang',
];
for (const t of listTypes) register(t, 'react:list', ActionListItem as any);
