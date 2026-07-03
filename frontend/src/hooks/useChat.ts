import { useCallback, useRef, useState } from 'react';
import type { Message } from '../types';
import { api } from '../services/api';

export function useChat(model: string, initialMessages: Message[]) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<Message[]>(initialMessages);

  // Keep ref in sync
  messagesRef.current = messages;

  const sendMessage = useCallback(
    async (content: string): Promise<string | undefined> => {
      if (!content.trim() || isStreaming) return;

      const userMessage: Message = { role: 'user', content: content.trim(), timestamp: Date.now() };
      const assistantMessage: Message = { role: 'assistant', content: '', timestamp: Date.now() };

      messagesRef.current = [...messagesRef.current, userMessage, assistantMessage];
      setMessages(messagesRef.current);
      setIsStreaming(true);
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;
      let convId: string | undefined;

      try {
        await api.streamChat(
          model,
          messagesRef.current.slice(0, -1), // exclude empty assistant placeholder
          undefined,
          {
            onChunk: (chunk) => {
              messagesRef.current = messagesRef.current.map((m, i) =>
                i === messagesRef.current.length - 1
                  ? { ...m, content: m.content + chunk }
                  : m
              );
              setMessages(messagesRef.current);
            },
            onConversationId: (id) => { convId = id; },
            onDone: () => {
              setIsStreaming(false);
              abortRef.current = null;
            },
            onError: (err) => {
              setError(err);
              setIsStreaming(false);
              abortRef.current = null;
              messagesRef.current = messagesRef.current.filter(
                (m) => !(m.role === 'assistant' && m.content === '')
              );
              setMessages(messagesRef.current);
            },
          },
          controller.signal
        );
        return convId;
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return convId;
        setError(e instanceof Error ? e.message : 'Unknown error');
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [model, isStreaming]
  );

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
    abortRef.current = null;
  }, []);

  return { messages, isStreaming, error, sendMessage, stopGeneration };
}
