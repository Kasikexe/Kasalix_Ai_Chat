import { useEffect, useRef, useState } from 'react';
import { Message } from './Message';
import type { Message as MessageType } from '../types';

interface Props {
  messages: MessageType[];
  isStreaming: boolean;
}

export function ChatWindow({ messages, isStreaming }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      setStickToBottom(scrollHeight - scrollTop - clientHeight < 80);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (stickToBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, stickToBottom]);

  const isEmpty = messages.length === 0;

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto">
      {isEmpty ? (
        <div className="h-full flex flex-col items-center justify-center px-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center mb-4 shadow-lg">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
              <path d="M12 8V4H8" />
              <rect width="16" height="12" x="4" y="8" rx="2" />
              <path d="M2 14h2" />
              <path d="M20 14h2" />
              <path d="M15 13v2" />
              <path d="M9 13v2" />
            </svg>
          </div>
          <h2 className="text-2xl font-semibold text-white mb-2">How can I help you today?</h2>
          <p className="text-gray-400 max-w-md">
            Start a conversation with your local AI model. Ask questions, get help with code, write content, or just chat.
          </p>
        </div>
      ) : (
        <div className="max-w-3xl mx-auto pb-4">
          {messages.map((msg, i) => (
            <Message
              key={i}
              message={msg}
              isStreaming={isStreaming && i === messages.length - 1 && msg.role === 'assistant'}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
