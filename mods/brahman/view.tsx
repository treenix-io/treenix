import { declareClientModule, declareView } from '@treenx/react/context/client-registry';
// Brahman — view registrations
// Registers react + react:list handlers for all brahman types

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

export const clientModules = [
  declareClientModule('@treenx/mods/brahman/view', [
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
    ...listTypes.map(type => declareView(type, 'react:list', ActionListItem))
  ])
];
