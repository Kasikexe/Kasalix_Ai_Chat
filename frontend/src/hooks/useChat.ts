import { useCallback, useRef, useState } from 'react';
import type { Message } from '../types';
import { api } from '../services/api';

export function useChat(
  model: string,
  initialMessages: Message[],
  initialConversationId?: string,
  thinkingEnabled = false
) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentStage, setCurrentStage] = useState<string>('');
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<Message[]>(initialMessages);
  const convIdRef = useRef<string | undefined>(initialConversationId);

  messagesRef.current = messages;
  convIdRef.current = conversationId;

  const sendMessage = useCallback(
    async (content: string): Promise<string | undefined> => {
      if (!content.trim() || isStreaming) return;

      const userMessage: Message = { role: 'user', content: content.trim(), timestamp: Date.now() };
      const assistantMessage: Message = { role: 'assistant', content: '', timestamp: Date.now() };

      messagesRef.current = [...messagesRef.current, userMessage, assistantMessage];
      setMessages(messagesRef.current);
      setIsStreaming(true);
      setError(null);
      setCurrentStage('');

      const controller = new AbortController();
      abortRef.current = controller;
      const currentConvId = convIdRef.current;

      try {
        await api.streamChat(
          model,
          messagesRef.current.slice(0, -1),
          currentConvId,
          {
            onChunk: (chunk) => {
              messagesRef.current = messagesRef.current.map((m, i) =>
                i === messagesRef.current.length - 1
                  ? { ...m, content: m.content + chunk }
                  : m
              );
              setMessages(messagesRef.current);
            },
            onConversationId: (id) => {
              setConversationId(id);
              convIdRef.current = id;
            },
            onStage: (stage) => {
              setCurrentStage(stage);
            },
            onDone: () => {
              setIsStreaming(false);
              setCurrentStage('');
              abortRef.current = null;
            },
            onError: (err) => {
              setError(err);
              setIsStreaming(false);
              setCurrentStage('');
              abortRef.current = null;
              messagesRef.current = messagesRef.current.filter(
                (m) => !(m.role === 'assistant' && m.content === '')
              );
              setMessages(messagesRef.current);
            },
          },
          controller.signal
        );
        return convIdRef.current;
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return convIdRef.current;
        setError(e instanceof Error ? e.message : 'Unknown error');
        setIsStreaming(false);
        setCurrentStage('');
        abortRef.current = null;
      }
    },
    [model, isStreaming]
  );

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
    setCurrentStage('');
    abortRef.current = null;
  }, []);

  return { messages, isStreaming, error, sendMessage, stopGeneration, conversationId, currentStage };
}
