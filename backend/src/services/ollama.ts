import type { Message, OllamaModel } from '../types';

const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

export async function getModels(): Promise<OllamaModel[]> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
  if (!res.ok) {
    throw new Error(`Failed to fetch models from Ollama: ${res.statusText}`);
  }
  const data = await res.json();
  return data.models || [];
}

export async function streamChat(
  model: string,
  messages: Message[],
  onChunk: (chunk: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Ollama error (${res.status}): ${errorText || res.statusText}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body from Ollama');

  const decoder = new TextDecoder();
  let buffer = '';

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
          if (data.error) throw new Error(data.error);
          if (data.message?.content) onChunk(data.message.content);
          if (data.done) return;
        } catch (e) {
          if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
            console.error('Parse error:', e);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
