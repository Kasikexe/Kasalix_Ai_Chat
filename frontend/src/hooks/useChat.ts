import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationMode, Message } from '../types';
import { api } from '../services/api';

const SYSTEM_PROMPT_KEY = 'ai-chat:systemPrompt';

function loadSystemPrompt(): string | null {
  try {
    return localStorage.getItem(SYSTEM_PROMPT_KEY) || null;
  } catch {
    return null;
  }
}

export function useChat(
  model: string,
  initialMessages: Message[],
  initialConversationId?: string,
  thinkingEnabled = false,
  mode: ConversationMode = 'chat',
  workspacePath?: string,
  searchEnabled = false
) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentStage, setCurrentStage] = useState<string>('');
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const [liveDuration, setLiveDuration] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<Message[]>(initialMessages);
  const convIdRef = useRef<string | undefined>(initialConversationId);
  const streamingRef = useRef(false);
  const startTimeRef = useRef<number>(0);

  messagesRef.current = messages;
  convIdRef.current = conversationId;

  // Live count-up timer during streaming
  useEffect(() => {
    if (!isStreaming) {
      setLiveDuration(0);
      return;
    }
    const interval = setInterval(() => {
      setLiveDuration(Date.now() - startTimeRef.current);
    }, 200);
    return () => clearInterval(interval);
  }, [isStreaming]);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const workspacePathRef = useRef(workspacePath);
  workspacePathRef.current = workspacePath;
  const searchEnabledRef = useRef(searchEnabled);
  searchEnabledRef.current = searchEnabled;

  const startStream = useCallback(async (convId: string | undefined): Promise<string | undefined> => {
    const controller = new AbortController();
    abortRef.current = controller;
    const currentConvId = convId;

    // Build messages to send — prepend system prompt if set
    const messagesToSend = (() => {
      const msgs = messagesRef.current.slice(0, -1);
      const sp = loadSystemPrompt();
      if (!sp) return msgs;
      // Check if a system message with this exact content is already present
      const alreadyHasSystem = msgs.some((m) => m.role === 'system' && m.content === sp);
      if (alreadyHasSystem) return msgs;
      // Remove any previous custom system prompts and add the current one
      const filtered = msgs.filter((m) => m.role !== 'system');
      return [{ role: 'system' as const, content: sp }, ...filtered];
    })();

    try {
      await api.streamChat(
        model,
        messagesToSend,
        currentConvId,
        {
          onChunk: (chunk) => {
            messagesRef.current = messagesRef.current.map((m, i) =>
              i === messagesRef.current.length - 1
                ? { ...m, content: m.content + chunk }
                : m
            );
            setMessages([...messagesRef.current]);
          },
          onConversationId: (id) => {
            setConversationId(id);
            convIdRef.current = id;
          },
          onStage: (stage) => {
            setCurrentStage(stage);
          },
          onDone: () => {
            // Store response duration on the last assistant message
            const duration = Date.now() - startTimeRef.current;
            const msgs = [...messagesRef.current];
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant') {
              msgs[lastIdx] = { ...msgs[lastIdx], durationMs: duration };
              messagesRef.current = msgs;
              setMessages(msgs);
            }
            setIsStreaming(false);
            streamingRef.current = false;
            setCurrentStage('');
            abortRef.current = null;
          },
          onError: (err) => {
            // Store duration even on error if there's partial content
            const duration = Date.now() - startTimeRef.current;
            const msgs = [...messagesRef.current];
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant') {
              msgs[lastIdx] = { ...msgs[lastIdx], durationMs: duration };
              messagesRef.current = msgs;
              setMessages(msgs);
            }

            setError(err);
            setIsStreaming(false);
            streamingRef.current = false;
            setCurrentStage('');
            abortRef.current = null;
            messagesRef.current = messagesRef.current.filter(
              (m) => !(m.role === 'assistant' && m.content === '')
            );
            setMessages([...messagesRef.current]);
          },
        },
        controller.signal,
        modeRef.current,
        workspacePathRef.current,
        searchEnabledRef.current
      );
      return convIdRef.current;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return convIdRef.current;
      setError(e instanceof Error ? e.message : 'Unknown error');
      setIsStreaming(false);
      streamingRef.current = false;
      setCurrentStage('');
      abortRef.current = null;
    }
  }, [model]);

  const sendMessage = useCallback(
    async (content: string): Promise<string | undefined> => {
      if (!content.trim() || streamingRef.current) return;

      const userMessage: Message = { role: 'user', content: content.trim(), timestamp: Date.now() };
      const assistantMessage: Message = { role: 'assistant', content: '', timestamp: Date.now() };

      messagesRef.current = [...messagesRef.current, userMessage, assistantMessage];
      setMessages([...messagesRef.current]);
      setIsStreaming(true);
      streamingRef.current = true;
      startTimeRef.current = Date.now();

      return startStream(convIdRef.current);
    },
    [startStream]
  );

  const regenerate = useCallback(
    async (): Promise<string | undefined> => {
      if (streamingRef.current) return;

      const msgs = messagesRef.current;
      let lastUserIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx === -1 || lastUserIdx === msgs.length - 1) return;

      messagesRef.current = msgs.slice(0, lastUserIdx + 1);
      const assistantMessage: Message = { role: 'assistant', content: '', timestamp: Date.now() };
      messagesRef.current = [...messagesRef.current, assistantMessage];
      setMessages([...messagesRef.current]);
      setIsStreaming(true);
      streamingRef.current = true;
      startTimeRef.current = Date.now();

      return startStream(convIdRef.current);
    },
    [startStream]
  );

  const editMessage = useCallback(
    async (index: number, newContent: string): Promise<string | undefined> => {
      if (!newContent.trim() || streamingRef.current) return;

      messagesRef.current = messagesRef.current.slice(0, index);
      const editedMessage: Message = { role: 'user', content: newContent.trim(), timestamp: Date.now() };
      const assistantMessage: Message = { role: 'assistant', content: '', timestamp: Date.now() };
      messagesRef.current = [...messagesRef.current, editedMessage, assistantMessage];
      setMessages([...messagesRef.current]);
      setIsStreaming(true);
      streamingRef.current = true;
      startTimeRef.current = Date.now();
      return startStream(convIdRef.current);
    },
    [startStream]
  );

  const deleteMessage = useCallback(
    async (index: number): Promise<void> => {
      if (streamingRef.current) return;
      if (!convIdRef.current) {
        // Not saved yet — just remove locally
        messagesRef.current = messagesRef.current.filter((_, i) => i !== index);
        setMessages([...messagesRef.current]);
        return;
      }
      try {
        const updated = await api.deleteConversationMessage(convIdRef.current, index);
        messagesRef.current = updated.messages;
        setMessages([...updated.messages]);
      } catch (e) {
        console.error('[useChat] Failed to delete message:', e);
      }
    },
    []
  );

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
    streamingRef.current = false;
    setCurrentStage('');
    abortRef.current = null;
  }, []);

  return { messages, isStreaming, error, sendMessage, regenerate, editMessage, deleteMessage, stopGeneration, conversationId, currentStage, liveDuration };
}
