// Brahman — view registrations
// Registers react + react:list handlers for all brahman types

import { register } from '@treenx/core';
import './types';
import {
  BackAction, BotConfig, BroadcastAction, EmitTextAction, EvalAction,
  FileAction, ForwardAction, GetValueAction, IfElseAction, KeywordSelectAction,
  MessageAction, OnErrorAction, PageConfig, PageNavAction, ParamsAction,
  QuestionAction, RemoveAction, ResetHistoryAction, ResetSessionAction,
  SelectLanguageAction, SetValueAction, TagAction,
} from './types';

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

register(BotConfig, 'react', BotView);
register(PageConfig, 'react', PageLayoutView);
register(PageConfig, 'react:chat', PageChatPreview);
register(PageConfig, 'react:chat:edit', PageChatEditor);
register(MessageAction, 'react', MessageEditor);
register(QuestionAction, 'react', QuestionEditor);
register(IfElseAction, 'react', IfElseEditor);
register(PageNavAction, 'react', PageNavEditor);
register(BackAction, 'react', BackEditor);
register(TagAction, 'react', TagEditor);
register(BroadcastAction, 'react', BroadcastEditor);
register(GetValueAction, 'react', GetValueEditor);
register(SetValueAction, 'react', SetValueEditor);
register(ParamsAction, 'react', ParamsEditor);
register(FileAction, 'react', FileEditor);
register(EvalAction, 'react', EvalEditor);
register(RemoveAction, 'react', RemoveEditor);
register(EmitTextAction, 'react', EmitTextEditor);
register(ForwardAction, 'react', ForwardEditor);
register(ResetSessionAction, 'react', ResetSessionEditor);
register(ResetHistoryAction, 'react', ResetHistoryEditor);
register(OnErrorAction, 'react', OnErrorEditor);
register(KeywordSelectAction, 'react', KeywordSelectEditor);
register(SelectLanguageAction, 'react', SelectLanguageEditor);

// ── Compact list items (react:list context) ──

const listTypes = [
  MessageAction, QuestionAction, IfElseAction,
  PageNavAction, BackAction, TagAction,
  BroadcastAction, GetValueAction, SetValueAction,
  ParamsAction, FileAction, EvalAction,
  RemoveAction, EmitTextAction, ForwardAction,
  ResetSessionAction, ResetHistoryAction, OnErrorAction,
  KeywordSelectAction, SelectLanguageAction,
];
for (const t of listTypes) register(t, 'react:list', ActionListItem);
