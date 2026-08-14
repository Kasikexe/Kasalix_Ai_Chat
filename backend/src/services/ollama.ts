import type { Message, OllamaModel } from '../types';

const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// Models that support thinking mode
// We force think=false on these when user wants fast mode
const THINKING_MODELS = ['qwen3', 'deepseek-r1', 'qwq', 'magpie'];

/**
 * Whether a model name belongs to a family that supports the `think` flag.
 * Exported so routes can surface this to clients (hide the toggle, warn hosts).
 */
export function modelSupportsThinking(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return THINKING_MODELS.some((m) => lower.includes(m));
}

// ─── Model-driven tool calling ──────────────────────────────
// Model families that support native function calling via Ollama's `tools`
// parameter. Only these get the model-driven tool loop; others fall back to
// keyword detection (which itself never lets a tool error kill the answer).
const TOOL_CAPABLE_MODELS = [
  'qwen3', 'qwen2.5', 'qwen2.5-coder', 'llama3.1', 'llama3.2', 'llama3.3',
  'mistral', 'mixtral', 'gemma3', 'phi4', 'phi-4', 'gpt-oss',
  'command-r', 'aya-expanse', 'minicpm-v', 'nemotron', 'molmo',
];

/** Whether a model family supports Ollama's native `tools`/tool_calls. */
export function modelSupportsTools(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return TOOL_CAPABLE_MODELS.some((m) => lower.includes(m));
}

/** A message used inside the model-driven tool-calling loop (transient, not persisted). */
export interface ToolLoopMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
}

export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

// ─── Model List Cache (#12) ────────────────────────────────
// Cache model list for 30 seconds to avoid repeated Ollama fetch calls
const MODEL_CACHE_TTL = 30_000; // 30 seconds
let modelCache: { data: OllamaModel[]; timestamp: number } | null = null;

export async function getModels(): Promise<OllamaModel[]> {
  // Return cached models if still fresh
  if (modelCache && Date.now() - modelCache.timestamp < MODEL_CACHE_TTL) {
    return modelCache.data;
  }

  const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
  if (!res.ok) {
    throw new Error(`Failed to fetch models from Ollama: ${res.statusText}`);
  }
  const data = await res.json();
  const models = data.models || [];

  // Update cache
  modelCache = { data: models, timestamp: Date.now() };
  return models;
}

/**
 * Clear the model list cache (e.g., when a new model is pulled).
 */
export function clearModelCache(): void {
  modelCache = null;
}

function convertMessagesForOllama(messages: (Message | ToolLoopMessage)[]): any[] {
  return messages.map((msg) => {
    const imageMatch = msg.content.match(/\[image:(data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+))\]/);
    if (imageMatch) {
      const textContent = msg.content
        .replace(/\[image:data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+\]/g, '')
        .trim();
      return {
        role: msg.role,
        content: textContent || 'Describe this image.',
        images: [imageMatch[2]],
      };
    }
    const base: any = { role: msg.role, content: msg.content };
    // Tool-calling rounds must echo the model's own tool_calls back so Ollama
    // can continue the conversation after we execute the tools.
    if ('tool_calls' in msg && (msg as ToolLoopMessage).tool_calls?.length) {
      base.tool_calls = (msg as ToolLoopMessage).tool_calls;
    }
    return base;
  });
}

export interface StreamOptions {
  signal?: AbortSignal;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  /**
   * Thinking mode for models that support it (qwen3, deepseek-r1, etc.)
   * - true: enable thinking (slower, more accurate)
   * - false: disable thinking (faster, direct response)
   * - undefined: use model's default (usually ON for qwen3)
   */
  think?: boolean;
  /**
   * Called with each reasoning/thinking chunk from models that support it
   * (qwen3, deepseek-r1, etc.). When provided, thinking is forwarded to the
   * caller instead of being silently dropped.
   */
  onThinking?: (chunk: string) => void;
}

export async function streamChat(
  model: string,
  messages: Message[],
  onChunk: (chunk: string) => void,
  options: StreamOptions = {}
): Promise<void> {
  const { signal, temperature, think, onThinking } = options;
  const ollamaMessages = convertMessagesForOllama(messages);

  const body: any = {
    model,
    messages: ollamaMessages,
    stream: true,
  };

  if (temperature !== undefined) {
    body.options = { ...body.options, temperature };
  }

  // Read top_p and max_tokens from the body if provided
  if (options.top_p !== undefined) {
    body.options = { ...body.options, top_p: options.top_p };
  }
  if (options.max_tokens !== undefined) {
    body.options = { ...body.options, num_predict: options.max_tokens };
  }

  // ALWAYS set think for models that support it
  // If user explicitly chose think=false, honor that
  // If user explicitly chose think=true, honor that
  // If undefined, force false to prevent silent thinking on slow hardware
  if (modelSupportsThinking(model)) {
    body.think = think === true; // explicit true or false, never undefined
  }

  console.log(
    `[ollama] Model: ${model}, think: ${body.think ?? 'n/a'}, temp: ${temperature ?? 'default'}`
  );

  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`[ollama] Error ${res.status}: ${errorText}`);
    throw new Error(`Ollama error (${res.status}): ${errorText || res.statusText}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body from Ollama');

  const decoder = new TextDecoder();
  let buffer = '';
  let totalChunks = 0;
  let thinkingSkipped = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const data = JSON.parse(trimmed);
          if (data.error) {
            console.error('[ollama] Stream error:', data.error);
            throw new Error(data.error);
          }

          // qwen3, deepseek-r1, etc. emit reasoning in a separate field.
          // Ollama's /api/chat stream uses "message.reasoning" for chat models;
          // "message.thinking" covers older/raw tool endpoints — accept both.
          // If a consumer provided onThinking, forward the reasoning chunks;
          // otherwise skip them so they don't pollute the normal content.
          const thinkingText = data.message?.reasoning ?? data.message?.thinking;
          if (thinkingText) {
            thinkingSkipped++;
            onThinking?.(thinkingText);
            continue;
          }

          if (data.message?.content) {
            totalChunks++;
            onChunk(data.message.content);
          }
          if (data.done) {
            console.log(
              `[ollama] Done. Chunks: ${totalChunks}, thinking skipped: ${thinkingSkipped}`
            );
            return;
          }
        } catch (e) {
          if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
            throw e;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * One round of model-driven tool calling: streams content to the caller like
 * streamChat, but also collects any `tool_calls` the model emits. The pipeline
 * executes those tools, appends the results, and calls this again — until the
 * model answers with content and no tool calls.
 *
 * Throws on Ollama errors (including models that reject the `tools` param) —
 * the pipeline falls back to the heuristic path in that case.
 */
export async function streamChatWithTools(
  model: string,
  messages: (Message | ToolLoopMessage)[],
  tools: Record<string, unknown>[],
  onChunk: (chunk: string) => void,
  options: StreamOptions = {}
): Promise<{ content: string; toolCalls: OllamaToolCall[] }> {
  const { signal, temperature, think, onThinking } = options;

  const body: any = {
    model,
    messages: convertMessagesForOllama(messages),
    stream: true,
    tools,
  };

  if (temperature !== undefined) body.options = { ...body.options, temperature };
  if (options.top_p !== undefined) body.options = { ...body.options, top_p: options.top_p };
  if (options.max_tokens !== undefined) body.options = { ...body.options, num_predict: options.max_tokens };
  if (modelSupportsThinking(model)) body.think = think === true;

  console.log(`[ollama] Tool round — model: ${model}, tools: ${tools.length}, think: ${body.think ?? 'n/a'}`);

  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`[ollama] Error ${res.status}: ${errorText}`);
    throw new Error(`Ollama error (${res.status}): ${errorText || res.statusText}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body from Ollama');

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls: OllamaToolCall[] = [];
  let finished = false;

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const data = JSON.parse(trimmed);
          if (data.error) {
            console.error('[ollama] Tool round stream error:', data.error);
            throw new Error(data.error);
          }

          const thinkingText = data.message?.reasoning ?? data.message?.thinking;
          if (thinkingText) {
            onThinking?.(thinkingText);
            continue;
          }

          if (data.message?.content) {
            content += data.message.content;
            onChunk(data.message.content);
          }
          if (Array.isArray(data.message?.tool_calls)) {
            for (const tc of data.message.tool_calls) {
              if (tc?.function?.name) toolCalls.push(tc);
            }
          }
          if (data.done) {
            console.log(`[ollama] Tool round done. content: ${content.length} chars, tool_calls: ${toolCalls.length}`);
            finished = true;
            break;
          }
        } catch (e) {
          if (e instanceof Error && e.message !== 'Unexpected end of JSON input') throw e;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { content, toolCalls };
}

/**
 * Non-streaming chat — sends a request and returns the full response at once.
 * Much faster than streamChat for small responses like title generation (#5).
 */
export async function chat(
  model: string,
  messages: Message[],
  options: StreamOptions = {}
): Promise<string> {
  const ollamaMessages = convertMessagesForOllama(messages);

  const body: any = {
    model,
    messages: ollamaMessages,
    stream: false,
  };

  if (options.temperature !== undefined) body.options = { ...body.options, temperature: options.temperature };
  if (options.top_p !== undefined) body.options = { ...body.options, top_p: options.top_p };
  if (options.max_tokens !== undefined) body.options = { ...body.options, num_predict: options.max_tokens };

  if (modelSupportsThinking(model)) {
    body.think = options.think === true;
  }

  console.log(`[ollama] Non-streaming — model: ${model}, temp: ${options.temperature ?? 'default'}`);

  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Ollama error (${res.status}): ${errorText || res.statusText}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(data.error);

  return data.message?.content || '';
}
