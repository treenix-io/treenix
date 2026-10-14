import { declareClientModule, declareView } from '@treenx/react/context/client-registry';
import type { View } from '@treenx/react';
import dayjs from 'dayjs';
// Brahman — view registrations
// Registers react + react:list handlers for all brahman types

import './types';
import {
  BackAction,
  BotConfig,
  BrahmanMessage,
  BroadcastAction,
  EmitTextAction,
  EvalAction,
  FileAction,
  ForwardAction,
  GetValueAction,
  IfElseAction,
  KeywordSelectAction,
  MessageAction,
  OnErrorAction,
  PageConfig,
  PageNavAction,
  ParamsAction,
  QuestionAction,
  RemoveAction,
  ResetHistoryAction,
  ResetSessionAction,
  SelectLanguageAction,
  SetValueAction,
  TagAction,
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

// ── Compact list items (react:list context) ──

const listTypes = [
  MessageAction,
  QuestionAction,
  IfElseAction,
  PageNavAction,
  BackAction,
  TagAction,
  BroadcastAction,
  GetValueAction,
  SetValueAction,
  ParamsAction,
  FileAction,
  EvalAction,
  RemoveAction,
  EmitTextAction,
  ForwardAction,
  ResetSessionAction,
  ResetHistoryAction,
  OnErrorAction,
  KeywordSelectAction,
  SelectLanguageAction,
];

const MessageRow: View<BrahmanMessage> = ({ value }) => (
  <div className="flex items-start gap-3 px-3 py-2 rounded-lg border border-border/60 hover:border-border">
    <span className="text-sm shrink-0">💬</span>
    <div className="flex-1 min-w-0">
      <div className="text-sm text-foreground whitespace-pre-wrap break-words">{value.text}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">
        {value.from} · {value.createdAt ? dayjs(value.createdAt).format('MMM D HH:mm') : ''}
      </div>
    </div>
  </div>
);

export const clientModules = [
  declareClientModule('@treenx/mods/brahman/view', [
    declareView(BrahmanMessage, 'react:list', MessageRow),
    declareView(BotConfig, 'react', BotView),
    declareView(PageConfig, 'react', PageLayoutView),
    declareView(PageConfig, 'react:chat', PageChatPreview),
    declareView(PageConfig, 'react:chat:edit', PageChatEditor),
    declareView(MessageAction, 'react', MessageEditor),
    declareView(QuestionAction, 'react', QuestionEditor),
    declareView(IfElseAction, 'react', IfElseEditor),
    declareView(PageNavAction, 'react', PageNavEditor),
    declareView(BackAction, 'react', BackEditor),
    declareView(TagAction, 'react', TagEditor),
    declareView(BroadcastAction, 'react', BroadcastEditor),
    declareView(GetValueAction, 'react', GetValueEditor),
    declareView(SetValueAction, 'react', SetValueEditor),
    declareView(ParamsAction, 'react', ParamsEditor),
    declareView(FileAction, 'react', FileEditor),
    declareView(EvalAction, 'react', EvalEditor),
    declareView(RemoveAction, 'react', RemoveEditor),
    declareView(EmitTextAction, 'react', EmitTextEditor),
    declareView(ForwardAction, 'react', ForwardEditor),
    declareView(ResetSessionAction, 'react', ResetSessionEditor),
    declareView(ResetHistoryAction, 'react', ResetHistoryEditor),
    declareView(OnErrorAction, 'react', OnErrorEditor),
    declareView(KeywordSelectAction, 'react', KeywordSelectEditor),
    declareView(SelectLanguageAction, 'react', SelectLanguageEditor),
    ...listTypes.map((type) => declareView(type, 'react:list', ActionListItem)),
  ]),
];
