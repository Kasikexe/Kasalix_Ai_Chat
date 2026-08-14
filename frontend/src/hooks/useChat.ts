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

// Storage keys for advanced settings
const TEMP_KEY = 'ai-chat:temperature';
const TOP_P_KEY = 'ai-chat:top_p';
const MAX_TOKENS_KEY = 'ai-chat:maxTokens';
const AUTO_TITLE_KEY = 'ai-chat:autoTitle';

export function loadSettings() {
  return {
    temperature: parseFloat(localStorage.getItem(TEMP_KEY) ?? '') || undefined,
    top_p: parseFloat(localStorage.getItem(TOP_P_KEY) ?? '') || undefined,
    max_tokens: parseInt(localStorage.getItem(MAX_TOKENS_KEY) ?? '', 10) || undefined,
    autoTitle: localStorage.getItem(AUTO_TITLE_KEY) !== 'false',
  };
}

// ─── Live stream store ───────────────────────────────────────────────────────
// Streaming state lives here (module-level) instead of inside the hook so a
// conversation's in-flight reply survives view switches: when the ChatView for
// a conversation unmounts (you open another chat mid-answer) the stream keeps
// updating this entry, and when you come back the freshly mounted hook simply
// re-attaches to the same entry — your typed message, the partial answer and
// the stage progress are all still there.

interface StreamHandlers {
  onConversationUpdate?: (id: string, updates: Partial<{ title: string }>) => void;
  /** Fired the first time a brand-new chat gets its real conversation id. */
  onConversationStarted?: (id: string) => void;
  onAgentTool?: (call: { tool: string; args: Record<string, unknown> }) => void;
  onFileWritten?: (write: { path: string; changeType: string; originalContent?: string }) => void;
  onAgentCommand?: (cmd: { command: string; output: string; failed: boolean }) => void;
  onQuestion?: (q: { key: string; question: string }) => void;
}

interface LiveEntry {
  /** 'new' until the backend assigns a conversation id, then the id itself. */
  key: string;
  conversationId: string | undefined;
  messages: Message[];
  isStreaming: boolean;
  error: string | null;
  currentStage: string;
  stageHistory: string[];
  liveDuration: number;
  startTime: number;
  abort: AbortController | null;
  handlers: StreamHandlers;
  listeners: Set<() => void>;
}

const liveStore = new Map<string, LiveEntry>();

function notify(entry: LiveEntry) {
  for (const listener of entry.listeners) listener();
}

function getOrCreateLiveEntry(
  key: string,
  initialMessages: Message[],
  handlers: StreamHandlers = {},
  initialConversationId?: string
): LiveEntry {
  const existing = liveStore.get(key);
  if (existing) {
    // Re-attach: a live stream (or completed stream) owns the current state —
    // never overwrite it with possibly-stale server data on remount.
    existing.handlers = handlers;
    return existing;
  }
  const entry: LiveEntry = {
    key,
    // CRITICAL: seed with the existing conversation id so follow-up messages
    // continue the SAME conversation. Without this, every message in an
    // existing chat was sent without an id and the backend silently created a
    // brand-new conversation each time.
    conversationId: initialConversationId,
    messages: [...initialMessages],
    isStreaming: false,
    error: null,
    currentStage: '',
    stageHistory: [],
    liveDuration: 0,
    startTime: 0,
    abort: null,
    handlers,
    listeners: new Set(),
  };
  liveStore.set(key, entry);
  return entry;
}

/** Move a live entry to a new key (a 'new' chat just got its real id). */
function migrateLiveEntry(fromKey: string, toKey: string): void {
  const entry = liveStore.get(fromKey);
  if (!entry || liveStore.has(toKey)) return;
  liveStore.delete(fromKey);
  entry.key = toKey;
  liveStore.set(toKey, entry);
}

/** Drop a conversation's cached stream state (used when it is deleted). */
export function discardLiveConversation(id: string): void {
  liveStore.delete(id);
}

// One shared timer drives every live duration counter, so it keeps counting
// even while the conversation's view is unmounted.
let timerStarted = false;
function ensureLiveTimer() {
  if (timerStarted) return;
  timerStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const entry of liveStore.values()) {
      if (entry.isStreaming && entry.startTime) {
        entry.liveDuration = now - entry.startTime;
        notify(entry);
      }
    }
  }, 250);
}

// ─── Hook ────────────────────────────────────────────────────────────────────
export function useChat(
  model: string,
  initialMessages: Message[],
  initialConversationId?: string,
  // Kept for signature compatibility — the actual thinking mode is read from
  // localStorage by api.streamChat, so this param is intentionally unused.
  thinkingEnabled = false,
  mode: ConversationMode = 'chat',
  workspacePath?: string,
  onConversationUpdate?: (id: string, updates: Partial<{ title: string }>) => void,
  planningEnabled = false,
  autoApply = false,
  onAgentTool?: (call: { tool: string; args: Record<string, unknown> }) => void,
  onFileWritten?: (write: { path: string; changeType: string; originalContent?: string }) => void,
  onAgentCommand?: (cmd: { command: string; output: string; failed: boolean }) => void,
  onQuestion?: (q: { key: string; question: string }) => void,
  onConversationStarted?: (id: string) => void
) {
  const key = initialConversationId ?? 'new';
  ensureLiveTimer();

  const makeHandlers = (): StreamHandlers => ({
    onConversationUpdate,
    onConversationStarted,
    onAgentTool,
    onFileWritten,
    onAgentCommand,
    onQuestion,
  });

  // The entry lives in the module store; this ref ALWAYS points at the store
  // object itself (never a copy), so mutations hit the object the listeners
  // and other mount instances share. A version counter only triggers renders —
  // the render reads live values straight from the ref.
  const entryRef = useRef<LiveEntry | null>(null);
  if (entryRef.current === null) {
    entryRef.current = getOrCreateLiveEntry(key, initialMessages, makeHandlers(), initialConversationId);
  }
  const [, setTick] = useState(0);

  // Subscribe to the live entry for this conversation. Re-runs when the
  // conversation changes and re-attaches to whatever stream is running for it.
  useEffect(() => {
    const target = getOrCreateLiveEntry(key, initialMessages, makeHandlers(), initialConversationId);
    entryRef.current = target;
    const listener = () => setTick((t) => t + 1);
    target.listeners.add(listener);
    return () => {
      target.listeners.delete(listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const startStream = useCallback(async (): Promise<string | undefined> => {
    // Guaranteed non-null: the render body above assigns it before any
    // callback can run.
    const e = entryRef.current!;
    const controller = new AbortController();
    e.abort = controller;
    const currentConvId = e.conversationId;

    // Build messages to send — prepend system prompt if set
    const messagesToSend = (() => {
      const msgs = e.messages.slice(0, -1);
      const sp = loadSystemPrompt();
      if (!sp) return msgs;
      // Check if a system message with this exact content is already present
      const alreadyHasSystem = msgs.some((m) => m.role === 'system' && m.content === sp);
      if (alreadyHasSystem) return msgs;
      // Remove any previous custom system prompts and add the current one
      const filtered = msgs.filter((m) => m.role !== 'system');
      return [{ role: 'system' as const, content: sp }, ...filtered];
    })();

    const settings = loadSettings();

    try {
      await api.streamChat(
        model,
        messagesToSend,
        currentConvId,
        {
          onChunk: (chunk) => {
            const msgs = e.messages;
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0) {
              e.messages = msgs.map((m, i) =>
                i === lastIdx ? { ...m, content: m.content + chunk } : m
              );
            }
            notify(e);
          },
          onThinking: (chunk) => {
            const msgs = e.messages;
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant') {
              e.messages = msgs.map((m, i) =>
                i === lastIdx ? { ...m, thinking: (m.thinking || '') + chunk } : m
              );
            }
            notify(e);
          },
          onConversationId: (id) => {
            const firstAssignment = !e.conversationId;
            e.conversationId = id;
            if (e.key === 'new') migrateLiveEntry('new', id);
            notify(e);
            // Only surface new conversations (regenerates/follow-ups reuse the
            // same id and are already registered).
            if (firstAssignment) e.handlers.onConversationStarted?.(id);
          },
          onStage: (stage) => {
            e.currentStage = stage;
            e.stageHistory = e.stageHistory[e.stageHistory.length - 1] === stage
              ? e.stageHistory
              : [...e.stageHistory, stage];
            notify(e);
          },
          onDone: async () => {
            // IMPORTANT: clear the streaming state FIRST — the auto-title call
            // below makes network requests that can hang (slow Ollama model
            // load, backend busy). If we cleared the state after it, the UI
            // would stay stuck in "replying" forever even though the reply
            // finished streaming.
            e.isStreaming = false;
            e.currentStage = '';
            e.abort = null;
            notify(e);

            // Store response duration on the last assistant message
            const duration = Date.now() - e.startTime;
            const lastIdx = e.messages.length - 1;
            if (lastIdx >= 0 && e.messages[lastIdx].role === 'assistant') {
              e.messages = e.messages.map((m, i) =>
                i === lastIdx ? { ...m, durationMs: duration } : m
              );
              notify(e);
            }

            // Auto-title: if this is the first response and autoTitle is enabled
            if (settings.autoTitle && currentConvId) {
              const lastMsg = e.messages[e.messages.length - 1];
              const hasContent = lastMsg && lastMsg.role === 'assistant' && lastMsg.content.length > 0;
              if (hasContent && e.messages.length <= 3) {
                const userMsg = messagesToSend.find((m) => m.role === 'user');
                if (userMsg) {
                  const textOnly = userMsg.content.replace(/\[image:[^\]]+\]/g, '').trim();
                  if (textOnly) {
                    try {
                      const title = await api.generateTitle(textOnly, model);
                      await api.updateConversation(currentConvId, { title });
                      // Notify parent to update local conversation state immediately
                      e.handlers.onConversationUpdate?.(currentConvId, { title });
                    } catch (err) {
                      console.error('[useChat] Auto-title failed:', err);
                    }
                  }
                }
              }
            }
          },
          onAgentTool: (call) => e.handlers.onAgentTool?.(call),
          onFileWritten: (write) => e.handlers.onFileWritten?.(write),
          onAgentCommand: (cmd) => e.handlers.onAgentCommand?.(cmd),
          onQuestion: (q) => e.handlers.onQuestion?.(q),
          onError: (err) => {
            // Store duration even on error if there's partial content
            const duration = Date.now() - e.startTime;
            const lastIdx = e.messages.length - 1;
            if (lastIdx >= 0 && e.messages[lastIdx].role === 'assistant') {
              e.messages = e.messages.map((m, i) =>
                i === lastIdx ? { ...m, durationMs: duration } : m
              );
            }
            e.error = err;
            e.isStreaming = false;
            e.currentStage = '';
            e.abort = null;
            e.messages = e.messages.filter(
              (m) => !(m.role === 'assistant' && m.content === '')
            );
            notify(e);
          },
        },
        controller.signal,
        mode,
        workspacePath,
        settings.temperature,
        settings.top_p,
        settings.max_tokens,
        planningEnabled,
        autoApply
      );
      return e.conversationId;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return e.conversationId;
      e.error = err instanceof Error ? err.message : 'Unknown error';
      e.isStreaming = false;
      e.currentStage = '';
      e.abort = null;
      notify(e);
    }
  }, [model, mode, workspacePath, planningEnabled, autoApply]);

  const sendMessage = useCallback(
    async (content: string): Promise<string | undefined> => {
      const e = entryRef.current!;
      if (!content.trim() || e.isStreaming) return;

      const userMessage: Message = { role: 'user', content: content.trim(), timestamp: Date.now() };
      const assistantMessage: Message = { role: 'assistant', content: '', timestamp: Date.now() };

      e.messages = [...e.messages, userMessage, assistantMessage];
      e.isStreaming = true;
      e.error = null;
      e.startTime = Date.now();
      e.stageHistory = [];
      notify(e);

      return startStream();
    },
    [startStream]
  );

  const regenerate = useCallback(
    async (): Promise<string | undefined> => {
      const e = entryRef.current!;
      if (e.isStreaming) return;

      const msgs = e.messages;
      let lastUserIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx === -1 || lastUserIdx === msgs.length - 1) return;

      e.messages = msgs.slice(0, lastUserIdx + 1);
      const assistantMessage: Message = { role: 'assistant', content: '', timestamp: Date.now() };
      e.messages = [...e.messages, assistantMessage];
      e.isStreaming = true;
      e.error = null;
      e.startTime = Date.now();
      e.stageHistory = [];
      notify(e);

      return startStream();
    },
    [startStream]
  );

  const editMessage = useCallback(
    async (index: number, newContent: string): Promise<string | undefined> => {
      const e = entryRef.current!;
      if (!newContent.trim() || e.isStreaming) return;

      e.messages = e.messages.slice(0, index);
      const editedMessage: Message = { role: 'user', content: newContent.trim(), timestamp: Date.now() };
      const assistantMessage: Message = { role: 'assistant', content: '', timestamp: Date.now() };
      e.messages = [...e.messages, editedMessage, assistantMessage];
      e.isStreaming = true;
      e.error = null;
      e.startTime = Date.now();
      e.stageHistory = [];
      notify(e);
      return startStream();
    },
    [startStream]
  );

  const deleteMessage = useCallback(
    async (index: number): Promise<void> => {
      const e = entryRef.current!;
      if (e.isStreaming) return;
      if (!e.conversationId) {
        // Not saved yet — just remove locally
        e.messages = e.messages.filter((_, i) => i !== index);
        notify(e);
        return;
      }
      try {
        const updated = await api.deleteConversationMessage(e.conversationId, index);
        e.messages = updated.messages;
        notify(e);
      } catch (err) {
        console.error('[useChat] Failed to delete message:', err);
      }
    },
    []
  );

  const stopGeneration = useCallback(() => {
    const e = entryRef.current!;
    e.abort?.abort();
    // Also tell the server to stop the pipeline and persist resume state —
    // client-side fetch abort alone doesn't reliably stop it server-side.
    const convId = e.conversationId;
    if (convId) api.stopChat(convId);
    e.isStreaming = false;
    e.currentStage = '';
    e.abort = null;
    notify(e);
  }, []);

  const e = entryRef.current!;
  return {
    messages: e.messages,
    isStreaming: e.isStreaming,
    error: e.error,
    sendMessage,
    regenerate,
    editMessage,
    deleteMessage,
    stopGeneration,
    conversationId: e.conversationId,
    currentStage: e.currentStage,
    stageHistory: e.stageHistory,
    liveDuration: e.liveDuration,
  };
}
