import { declareClientModule, declareView } from '@treenx/react/context/client-registry';
// Chat view — interactive AI chat on any node with ai.chat + ai.thread + ai.agent
// Registered on ai.chat component. Streams through the selected tree source.

import { getComponent } from '@treenx/core';
import { cn, useActions, useCurrentNode, useTreeEffects, type View } from '@treenx/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AiChat, AiThread, type ChatChunk, type ThreadMessage } from '#agent/types';
import { LogRenderer } from '#agent/views/log';

declare module '@treenx/react/hooks' {
  interface ActionChunks {
    'ai.chat': { send: ChatChunk };
  }
}

const ChatView: View<AiChat> = ({ value, ctx }) => {
  const node = useCurrentNode();
  const path = node.$path;
  const thread = getComponent(node, AiThread);
  if (thread === undefined) throw new Error('Chat requires an ai.thread component');
  const messages = thread.messages;
  const effects = useTreeEffects();
  const actions = useActions(value);

  const [input, setInput] = useState('');
  const [streamText, setStreamText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(
    () => () => {
      unsubRef.current?.();
      unsubRef.current = null;
    },
    [path],
  );

  // Auto-scroll on new messages or stream text
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamText]);

  // Clear stream text when the persisted message arrives (messages.length grows)
  const prevMsgCount = useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevMsgCount.current && streamText) {
      setStreamText('');
      setStreaming(false);
    }
    prevMsgCount.current = messages.length;
  }, [messages.length]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || streaming) return;

    setInput('');
    setStreamText('');
    setStreaming(true);
    setError(null);

    if (ctx === null || ctx === undefined) throw new Error('Chat has no node context');
    const pieces = effects.stream({
      path: ctx.path,
      action: 'send',
      type: 'ai.chat',
      args: { text },
    });
    const consume = (async () => {
      try {
        for await (const chunk of pieces)
          if (chunk.type === 'chunk') setStreamText((previous) => previous + chunk.text);
      } catch (reason) {
        setStreamText('');
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setStreaming(false);
      }
    })();
    unsubRef.current = () => {
      void pieces.return?.().then(() => consume);
    };
  }, [ctx, effects, input, streaming]);

  const stop = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    actions
      .stop()
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    setStreaming(false);
    setStreamText('');
  }, [actions]);

  const clear = useCallback(() => {
    if (streaming) stop();
    actions.clear();
  }, [actions, streaming, stop]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col h-full max-w-2xl">
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        {messages.length === 0 && !streaming && (
          <p className="text-sm text-muted-foreground italic py-8 text-center">No messages yet</p>
        )}

        {messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} />
        ))}

        {/* Streaming preview — visible while streaming OR until persisted message arrives */}
        {streamText && (
          <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-violet-500/20 flex items-center justify-center shrink-0">
              <span className="text-[10px] text-violet-400 font-bold">AI</span>
            </div>
            <div className="flex-1 min-w-0">
              <LogRenderer text={streamText} className="text-sm" />
              <span className="inline-block w-1.5 h-4 bg-violet-400 animate-pulse ml-0.5 align-text-bottom" />
            </div>
          </div>
        )}

        {streaming && !streamText && (
          <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-violet-500/20 flex items-center justify-center shrink-0">
              <span className="text-[10px] text-violet-400 font-bold">AI</span>
            </div>
            <div className="flex items-center gap-1 py-2">
              <span
                className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce"
                style={{ animationDelay: '0ms' }}
              />
              <span
                className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce"
                style={{ animationDelay: '150ms' }}
              />
              <span
                className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce"
                style={{ animationDelay: '300ms' }}
              />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="shrink-0 border-t border-border px-4 py-4 pb-6 flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message..."
          disabled={streaming}
          rows={1}
          className={cn(
            'flex-1 resize-none rounded-lg border border-border bg-card/50 px-3 py-2',
            'text-sm text-foreground placeholder:text-muted-foreground',
            'focus:outline-none focus:border-border',
            'field-sizing-content min-h-[38px] max-h-48',
            streaming && 'opacity-50 cursor-not-allowed',
          )}
        />

        {streaming ? (
          <button
            onClick={stop}
            className="shrink-0 px-3 py-2 rounded-lg text-xs font-medium bg-red-600/20 text-red-400 border border-red-500/20 hover:bg-red-600/30 transition-colors"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!input.trim()}
            className={cn(
              'shrink-0 px-3 py-2 rounded-lg text-xs font-medium border transition-colors',
              input.trim()
                ? 'bg-violet-600/20 text-violet-400 border-violet-500/20 hover:bg-violet-600/30'
                : 'bg-card/30 text-muted-foreground border-border cursor-not-allowed',
            )}
          >
            Send
          </button>
        )}

        {messages.length > 0 && !streaming && (
          <button
            onClick={clear}
            className="shrink-0 px-2 py-2 rounded-lg text-xs text-muted-foreground hover:text-muted-foreground transition-colors"
            title="Clear messages and start a new session"
          >
            New Chat
          </button>
        )}
      </div>
    </div>
  );
};

function MessageBubble({ msg }: { msg: ThreadMessage }) {
  const isUser = msg.role === 'user';

  return (
    <div className={cn('flex gap-3', isUser && 'flex-row-reverse')}>
      <div
        className={cn(
          'w-7 h-7 rounded-full flex items-center justify-center shrink-0',
          isUser ? 'bg-sky-500/20' : 'bg-violet-500/20',
        )}
      >
        <span className={cn('text-[10px] font-bold', isUser ? 'text-sky-400' : 'text-violet-400')}>
          {isUser ? 'U' : 'AI'}
        </span>
      </div>

      <div className={cn('flex-1 min-w-0', isUser && 'text-right')}>
        {isUser ? (
          <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{msg.text}</p>
        ) : (
          <LogRenderer text={msg.text} className="text-sm text-foreground" />
        )}
      </div>
    </div>
  );
}

export const clientModules = [
  declareClientModule('@treenx/mods/agent/views/chat', [declareView(AiChat, 'react', ChatView)]),
];
