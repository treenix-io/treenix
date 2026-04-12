// Chat view — interactive AI chat on any node with ai.chat + ai.thread + ai.agent
// Registered on ai.chat component. Streams via trpc.streamAction.subscribe.

import { register } from '@treenity/core';
import { cn, execute, trpc, useActions, useCurrentNode, usePath, type View } from '@treenity/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AiChat, AiThread, type ThreadMessage } from '../types';
import { LogRenderer } from './log';

const ChatView: View<AiChat> = ({ value }) => {
  const node = useCurrentNode();
  const path = node.$path;
  const { data: thread } = usePath(path, AiThread, 'thread');
  const messages: ThreadMessage[] = thread?.messages ?? [];

  const [input, setInput] = useState('');
  const [streamText, setStreamText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

    const sub = trpc.streamAction.subscribe(
      { path, action: 'send', type: 'ai.chat', key: 'chat', data: { text } },
      {
        onData: (item) => {
          const chunk = item as { type: string; text: string };
          if (chunk.type === 'chunk') {
            setStreamText(prev => prev + chunk.text);
          }
        },
        onComplete: () => {
          // Don't clear streamText here — wait for persisted message to arrive
          // via subscription (messages.length change above)
        },
        onError: () => {
          setStreaming(false);
          setStreamText('');
        },
      },
    );
    unsubRef.current = () => sub.unsubscribe();
  }, [path, input, streaming]);

  const actions = useActions(value);

  const stop = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    execute(path, 'stop');
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
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        {messages.length === 0 && !streaming && (
          <p className="text-sm text-zinc-600 italic py-8 text-center">No messages yet</p>
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
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="shrink-0 border-t border-zinc-800 px-4 py-4 pb-6 flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message..."
          disabled={streaming}
          rows={1}
          className={cn(
            'flex-1 resize-none rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2',
            'text-sm text-zinc-200 placeholder:text-zinc-600',
            'focus:outline-none focus:border-zinc-600',
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
                : 'bg-zinc-800/30 text-zinc-600 border-zinc-800 cursor-not-allowed',
            )}
          >
            Send
          </button>
        )}

        {messages.length > 0 && !streaming && (
          <button
            onClick={clear}
            className="shrink-0 px-2 py-2 rounded-lg text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
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
      <div className={cn(
        'w-7 h-7 rounded-full flex items-center justify-center shrink-0',
        isUser ? 'bg-sky-500/20' : 'bg-violet-500/20',
      )}>
        <span className={cn('text-[10px] font-bold', isUser ? 'text-sky-400' : 'text-violet-400')}>
          {isUser ? 'U' : 'AI'}
        </span>
      </div>

      <div className={cn('flex-1 min-w-0', isUser && 'text-right')}>
        {isUser ? (
          <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{msg.text}</p>
        ) : (
          <LogRenderer text={msg.text} className="text-sm text-zinc-300" />
        )}
      </div>
    </div>
  );
}

register(AiChat, 'react', ChatView);
