import type { Message, OllamaModel } from '../types';

const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// Models that support thinking mode
// We force think=false on these when user wants fast mode
const THINKING_MODELS = ['qwen3', 'deepseek-r1', 'qwq', 'magpie'];

function modelSupportsThinking(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return THINKING_MODELS.some((m) => lower.includes(m));
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

function convertMessagesForOllama(messages: Message[]): any[] {
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
    return {
      role: msg.role,
      content: msg.content,
    };
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
}

export async function streamChat(
  model: string,
  messages: Message[],
  onChunk: (chunk: string) => void,
  options: StreamOptions = {}
): Promise<void> {
  const { signal, temperature, think } = options;
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

          // qwen3, deepseek-r1, etc. emit thinking in a separate field
          // We skip it so it doesn't reach the user
          if (data.message?.thinking) {
            thinkingSkipped++;
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
