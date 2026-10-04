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
  onToolResult?: (r: { tool: string; ok: boolean; output: string }) => void;
  onFileWritten?: (write: { path: string; changeType: string; originalContent?: string }) => void;
  onAgentCommand?: (cmd: { command: string; output: string; failed: boolean }) => void;
  onQuestion?: (q: { key: string; question: string }) => void;
  onApprovalRequest?: (q: { key: string; tool: string; args: Record<string, unknown> }) => void;
  onPlan?: (plan: string) => void;
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
  currentPlan: string;
  /** Accumulated thinking text since the last tool call (flushed to timeline on tool/finish) */
  thinkingBuffer: string;
  /** Live tokens/s estimate while streaming (chars/4 ÷ elapsed seconds) */
  liveTps: number | null;
  /** Exact tokens/s from Ollama's final stats, applied to the message on done */
  finalTps: number | null;
  finalEvalCount: number | null;
  /** First content chunk timestamp — live tok/s starts from real generation, not request start */
  firstChunkAt: number;
  /** Content chars before the current visible round — excluded from the live rate */
  charsAtLastRoundStart: number;
  /** Sliding-window samples {time, roundChars} for the live tok/s rate */
  rateSamples: { t: number; chars: number }[];
  /** Last tick a live rate was computed (used to hide the badge when stalled) */
  lastRateAt: number;
  /** chars→tokens ratio for the live estimate — self-calibrated from Ollama's exact eval_count */
  charsPerToken: number;
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
    currentPlan: '',
    thinkingBuffer: '',
    liveTps: null,
    finalTps: null,
    finalEvalCount: null,
    firstChunkAt: 0,
    charsAtLastRoundStart: 0,
    rateSamples: [],
    lastRateAt: 0,
    charsPerToken: 4,
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
/** Sliding window for the live tok/s rate — only recent generation counts. */
const RATE_WINDOW_MS = 3000;
function ensureLiveTimer() {
  if (timerStarted) return;
  timerStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const entry of liveStore.values()) {
      if (entry.isStreaming && entry.startTime) {
        entry.liveDuration = now - entry.startTime;
        // LIVE tokens/s — a sliding-window INSTANTANEOUS rate, not a
        // cumulative average. (The old cumulative math spiked at the start
        // — first burst ÷ tiny elapsed — then decayed toward garbage
        // whenever thinking/tools/pauses added elapsed time without
        // content, making a steady 15 tok/s model read as 5.)
        const totalChars = entry.messages.reduce(
          (acc, m) => acc + (m.role === 'assistant' ? m.content.length : 0),
          0
        );
        const roundChars = Math.max(0, totalChars - entry.charsAtLastRoundStart);
        entry.rateSamples.push({ t: now, chars: roundChars });
        while (entry.rateSamples.length > 2 && now - entry.rateSamples[0].t > RATE_WINDOW_MS) {
          entry.rateSamples.shift();
        }
        const oldest = entry.rateSamples[0];
        const spanS = (now - oldest.t) / 1000;
        const delta = roundChars - oldest.chars;
        if (spanS >= 1.2 && delta > 2) {
          // Requires ~1.2s of window so an initial burst can't fake a huge
          // speed; the ratio is calibrated from Ollama's real eval_count.
          entry.liveTps = Math.max(1, Math.round(delta / entry.charsPerToken / spanS));
          entry.lastRateAt = now;
        } else if (now - entry.lastRateAt > 4000) {
          // No fresh content for 4s — thinking, running tools, or stalled.
          // Hide the badge instead of showing a decayed meaningless number.
          entry.liveTps = null;
        }
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
  onConversationStarted?: (id: string) => void,
  onApprovalRequest?: (q: { key: string; tool: string; args: Record<string, unknown> }) => void,
  onPlan?: (plan: string) => void,
  planMode?: 'off' | 'on' | 'auto',
  toolPermission?: 'auto' | 'read-only' | 'ask-each' | 'suggest' | 'auto-edit'
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
    onApprovalRequest,
    onPlan,
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
      const msgs = e.messages.slice(0, -1).filter((m) => m.role !== 'activity');
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
            if (!e.firstChunkAt) e.firstChunkAt = Date.now();
            const msgs = e.messages;
            // Find the last assistant message, not just the last message.
            // During the agent loop, onAgentTool inserts 'activity' role
            // messages between tool calls — appending to lastIdx would land
            // chunks on an activity message instead of the assistant reply.
            let assistantIdx = -1;
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'assistant') { assistantIdx = i; break; }
            }
            if (assistantIdx >= 0) {
              e.messages = msgs.map((m, i) =>
                i === assistantIdx ? { ...m, content: m.content + chunk } : m
              );
            }
            notify(e);
          },
          onThinking: (chunk) => {
            // Accumulate thinking and surface it LIVE: the growing text goes
            // into a temporary live timeline event (pulsing indicator in the
            // UI). On flush (tool call / done) it becomes a normal collapsed
            // thinking event. Previously thinking only appeared AFTER the next
            // tool call — the user stared at nothing during long model rounds.
            e.thinkingBuffer += chunk;
            if (e.thinkingBuffer.length >= 24) {
              const msgs = e.messages;
              let assistantIdx = -1;
              for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === 'assistant') { assistantIdx = i; break; }
              }
              if (assistantIdx >= 0) {
                const msg = msgs[assistantIdx];
                const timeline = [...(msg.timeline || [])];
                const last = timeline[timeline.length - 1];
                if (last && last.type === 'thinking' && (last as any).live) {
                  timeline[timeline.length - 1] = { type: 'thinking', content: e.thinkingBuffer, live: true } as any;
                } else {
                  timeline.push({ type: 'thinking', content: e.thinkingBuffer, live: true } as any);
                }
                e.messages = msgs.map((m, i) => i === assistantIdx ? { ...m, timeline } : m);
              }
            }
            notify(e);
          },
          onNarration: (text) => {
            // The model's own words between tool calls ("Now let me write the
            // movement function") — a narration timeline event, rendered as
            // the model speaking. Also flush any live thinking, since the
            // round that produced the narration is ending.
            const msgs = e.messages;
            let assistantIdx = -1;
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'assistant') { assistantIdx = i; break; }
            }
            if (assistantIdx >= 0) {
              const msg = msgs[assistantIdx];
              const timeline = [...(msg.timeline || [])];
              // Flush live thinking first so order stays: thinking → narration → tool
              if (e.thinkingBuffer.trim()) {
                const last = timeline[timeline.length - 1];
                if (last && last.type === 'thinking' && (last as any).live) {
                  timeline[timeline.length - 1] = { type: 'thinking', content: e.thinkingBuffer } as any;
                } else {
                  timeline.push({ type: 'thinking' as const, content: e.thinkingBuffer });
                }
                e.thinkingBuffer = '';
              }
              timeline.push({ type: 'narration' as const, content: text });
              e.messages = msgs.map((m, i) => i === assistantIdx ? { ...m, timeline } : m);
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
            // A new tool round is starting — remember how much content exists
            // so the live rate only counts the final visible round, and clear
            // the sliding window so old samples don't leak across rounds.
            if (stage === 'chat:thinking' || stage === 'tool:executing') {
              e.charsAtLastRoundStart = e.messages.reduce(
                (acc, m) => acc + (m.role === 'assistant' ? m.content.length : 0),
                0
              );
              e.rateSamples = [];
            }
            notify(e);
            // Cloud unavailable notification — show a toast so the user knows
            if (stage === 'cloud:unavailable') {
              // Dynamic import to avoid circular deps; ToastProvider is always mounted
              import('./useToast').then(({ useToast }) => {
                // We can't call the hook here (it's a callback, not a component),
                // so we dispatch a custom event that App.tsx listens for.
                window.dispatchEvent(new CustomEvent('cloud-unavailable'));
              }).catch(() => {});
            }
          },
          onMetrics: (m) => {
            // Exact stats from Ollama's final stream chunk — attached to the
            // last assistant message immediately and used on done.
            e.finalTps = m.tokensPerSecond;
            e.finalEvalCount = m.evalCount;
            e.liveTps = null;
            e.rateSamples = [];
            // Self-calibration: chars just generated ÷ exact token count
            // gives the real chars→token ratio for THIS model's output style
            // (code-heavy output is ~1.5, prose ~4 — a fixed guess was off
            // by 3x). Clamp to sane bounds so one weird round can't poison it.
            const roundChars = Math.max(0,
              e.messages.reduce((acc, msg) => acc + (msg.role === 'assistant' ? msg.content.length : 0), 0)
              - e.charsAtLastRoundStart
            );
            if (m.evalCount > 0 && roundChars > 0) {
              const measured = roundChars / m.evalCount;
              e.charsPerToken = Math.min(12, Math.max(1, measured));
            }
            const msgs = e.messages;
            let assistantIdx = -1;
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'assistant') { assistantIdx = i; break; }
            }
            if (assistantIdx >= 0) {
              e.messages = msgs.map((msg, i) =>
                i === assistantIdx ? { ...msg, tokensPerSecond: m.tokensPerSecond, evalCount: m.evalCount } : msg
              );
            }
            notify(e);
          },
          onModelInfo: (model, source) => {
            const msgs = e.messages;
            let assistantIdx = -1;
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'assistant') { assistantIdx = i; break; }
            }
            if (assistantIdx >= 0) {
              e.messages = msgs.map((m, i) =>
                i === assistantIdx ? { ...m, generatedBy: model, modelSource: source as 'local' | 'cloud' } : m
              );
              notify(e);
            }
          },
          onSources: (sources) => {
            // Pages the web search used — attached to the streaming reply so
            // they show (and stay) with it. Arrives before 'done'.
            if (!sources.length) return;
            const msgs = e.messages;
            let assistantIdx = -1;
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'assistant') { assistantIdx = i; break; }
            }
            if (assistantIdx >= 0) {
              e.messages = msgs.map((m, i) =>
                i === assistantIdx ? { ...m, sources } : m
              );
              notify(e);
            }
          },
          onDone: async () => {
            // Flush any remaining thinking buffer to the timeline (finalize the
            // live event in place if present — no duplicate row)
            if (e.thinkingBuffer.trim()) {
              const msgs = e.messages;
              let assistantIdx = -1;
              for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === 'assistant') { assistantIdx = i; break; }
              }
              if (assistantIdx >= 0) {
                const msg = msgs[assistantIdx];
                const timeline = [...(msg.timeline || [])];
                const last = timeline[timeline.length - 1];
                if (last && last.type === 'thinking' && (last as any).live) {
                  timeline[timeline.length - 1] = { type: 'thinking', content: e.thinkingBuffer } as any;
                } else {
                  timeline.push({ type: 'thinking' as const, content: e.thinkingBuffer });
                }
                e.messages = msgs.map((m, i) => i === assistantIdx ? { ...m, timeline } : m);
              }
              e.thinkingBuffer = '';
            }
            // IMPORTANT: clear the streaming state FIRST — the auto-title call
            // below makes network requests that can hang (slow Ollama model
            // load, backend busy). If we cleared the state after it, the UI
            // would stay stuck in "replying" forever even though the reply
            // finished streaming.
            e.isStreaming = false;
            e.currentStage = '';
            e.abort = null;
            e.liveTps = null;
            notify(e);

            // Store response duration on the last assistant message
            const duration = Date.now() - e.startTime;
            let durationIdx = -1;
            for (let i = e.messages.length - 1; i >= 0; i--) {
              if (e.messages[i].role === 'assistant') { durationIdx = i; break; }
            }
            if (durationIdx >= 0) {
              e.messages = e.messages.map((m, i) =>
                i === durationIdx ? { ...m, durationMs: duration } : m
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
          onAgentTool: (call) => {
            e.handlers.onAgentTool?.(call);
            // Append a tool event to the assistant message's timeline
            const argPreview = typeof call.args?.path === 'string'
              ? call.args.path
              : typeof call.args?.command === 'string'
              ? call.args.command
              : typeof call.args?.query === 'string'
              ? call.args.query
              : '';
            // Search backwards for the LAST assistant message (not the first)
            let assistantIdx = -1;
            for (let i = e.messages.length - 1; i >= 0; i--) {
              if (e.messages[i].role === 'assistant') { assistantIdx = i; break; }
            }
            if (assistantIdx >= 0) {
              const msg = e.messages[assistantIdx];
              const timeline = [...(msg.timeline || [])];
              // Flush accumulated thinking buffer as a timeline event before this tool call.
              // If the live event exists, finalize it in place (no duplicate row).
              if (e.thinkingBuffer.trim()) {
                const last = timeline[timeline.length - 1];
                if (last && last.type === 'thinking' && (last as any).live) {
                  timeline[timeline.length - 1] = { type: 'thinking', content: e.thinkingBuffer } as any;
                } else {
                  timeline.push({ type: 'thinking', content: e.thinkingBuffer });
                }
                e.thinkingBuffer = '';
              }
              timeline.push({ type: 'tool', tool: call.tool, args: argPreview, status: 'done' as const });
              e.messages = e.messages.map((m, i) => i === assistantIdx ? { ...m, timeline } : m);
            } else {
              // Fallback: create activity message if no assistant message exists yet
              e.messages = [...e.messages, {
                role: 'activity' as const,
                content: `${call.tool}${argPreview ? ': ' + argPreview : ''}`,
                activityTool: call.tool,
                activityArgs: argPreview,
                activityStatus: 'done' as const,
                activityMs: 0,
                timestamp: Date.now(),
              }];
            }
            notify(e);
          },
          onFileWritten: (write) => e.handlers.onFileWritten?.(write),
          onToolResult: (r) => {
            // Attach the tool's output (command stdout, edit diff) to the most
            // recent matching tool event without a result yet — makes tool rows
            // clickable to reveal what actually happened.
            for (let i = e.messages.length - 1; i >= 0; i--) {
              const m = e.messages[i];
              if (m.role !== 'assistant' || !m.timeline) continue;
              const timeline = [...m.timeline];
              for (let j = timeline.length - 1; j >= 0; j--) {
                const ev = timeline[j];
                if (ev.type === 'tool' && ev.tool === r.tool && ev.result === undefined) {
                  timeline[j] = { ...ev, result: r.output, ok: r.ok } as typeof ev;
                  e.messages = e.messages.map((mm, k) => k === i ? { ...mm, timeline } : mm);
                  notify(e);
                  return;
                }
              }
            }
          },
          onAgentCommand: (cmd) => e.handlers.onAgentCommand?.(cmd),
          onQuestion: (q) => e.handlers.onQuestion?.(q),
          onApprovalRequest: (q) => e.handlers.onApprovalRequest?.(q),
          onPlan: (plan) => {
            e.currentPlan = plan;
            // Chat message is emitted by the backend (onChunk) — no duplicate injection here.
            notify(e);
          },
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
            e.liveTps = null;
            e.messages = e.messages.filter(
              (m) => !(m.role === 'assistant' && m.content === '')
            );
            notify(e);
            // Show the cloud-fallback toast only for genuinely cloud-specific
            // failures. This used to match "ollama error" anywhere, so a local
            // model error (e.g. "does not support tools") claimed the cloud
            // provider was unavailable and that we were falling back to local
            // models — while already running local models.
            if (/cloud|api[ _-]?key|authentication|unauthorized|ollama\.com|getaddrinfo/i.test(err)) {
              import('./useToast').then(({ useToast }) => {
                window.dispatchEvent(new CustomEvent('cloud-unavailable'));
              }).catch(() => {});
            }
          },
        },
        controller.signal,
        mode,
        workspacePath,
        settings.temperature,
        settings.top_p,
        settings.max_tokens,
        planningEnabled,
        autoApply,
        planMode,
        toolPermission
      );
      return e.conversationId;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return e.conversationId;
      e.error = err instanceof Error ? err.message : 'Unknown error';
      e.isStreaming = false;
      e.currentStage = '';
      e.abort = null;
      e.liveTps = null;
      notify(e);
    }
  }, [model, mode, workspacePath, planningEnabled, autoApply, planMode, toolPermission]);

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
      e.liveTps = null;
      e.finalTps = null;
      e.finalEvalCount = null;
      e.firstChunkAt = 0;
      e.charsAtLastRoundStart = 0;
      e.rateSamples = [];
      e.lastRateAt = 0;
      // charsPerToken persists — it's calibrated from Ollama's exact counts
      // and carries across messages for a better live estimate.
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
      e.liveTps = null;
      e.finalTps = null;
      e.finalEvalCount = null;
      e.firstChunkAt = 0;
      e.charsAtLastRoundStart = 0;
      e.rateSamples = [];
      e.lastRateAt = 0;
      // charsPerToken persists — it's calibrated from Ollama's exact counts
      // and carries across messages for a better live estimate.
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
      e.liveTps = null;
      e.finalTps = null;
      e.finalEvalCount = null;
      e.firstChunkAt = 0;
      e.charsAtLastRoundStart = 0;
      e.rateSamples = [];
      e.lastRateAt = 0;
      // charsPerToken persists — it's calibrated from Ollama's exact counts
      // and carries across messages for a better live estimate.
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
    e.liveTps = null;
    notify(e);
  }, []);

  const e = entryRef.current!;
  const addActivity = useCallback((activity: { tool: string; args: Record<string, unknown> }) => {
    const e = entryRef.current!;
    const argPreview = typeof activity.args?.path === 'string'
      ? activity.args.path
      : typeof activity.args?.command === 'string'
      ? activity.args.command
      : typeof activity.args?.query === 'string'
      ? activity.args.query
      : '';
    e.messages = [...e.messages, {
      role: 'activity' as const,
      content: `${activity.tool}${argPreview ? ': ' + argPreview : ''}`,
      activityTool: activity.tool,
      activityArgs: argPreview,
      activityStatus: 'done' as const,
      activityMs: 0,
      timestamp: Date.now(),
    }];
    notify(e);
  }, []);

  return {
    messages: e.messages,
    isStreaming: e.isStreaming,
    error: e.error,
    sendMessage,
    regenerate,
    editMessage,
    deleteMessage,
    stopGeneration,
    addActivity,
    conversationId: e.conversationId,
    currentStage: e.currentStage,
    stageHistory: e.stageHistory,
    liveDuration: e.liveDuration,
    liveTps: e.liveTps,
    currentPlan: e.currentPlan,
  };
}
