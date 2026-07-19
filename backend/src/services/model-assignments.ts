import { promises as fs } from 'fs';
import path from 'path';

const SETTINGS_FILE = path.join(process.cwd(), 'data', 'settings.json');

/**
 * All assignable model roles in the app.
 * Keys map to UI categories; values are Ollama model names (e.g. "qwen3:4b").
 */
export interface ModelAssignments {
  chat_thinking: string;
  chat_fast: string;
  code: string;
  vision: string;
  extraction: string;
  editor: string;
  editor_vision: string;
}

export const ASSIGNMENT_KEYS: (keyof ModelAssignments)[] = [
  'chat_thinking',
  'chat_fast',
  'code',
  'vision',
  'extraction',
  'editor',
  'editor_vision',
];

export const ASSIGNMENT_LABELS: Record<keyof ModelAssignments, string> = {
  chat_thinking: 'Chat (Thinking)',
  chat_fast: 'Chat (Fast)',
  code: 'Code Generation',
  vision: 'Vision Analysis',
  extraction: 'Memory Extraction',
  editor: 'Video Editor',
  editor_vision: 'Editor Vision',
};

export const ASSIGNMENT_ICONS: Record<keyof ModelAssignments, string> = {
  chat_thinking: '🧠',
  chat_fast: '⚡',
  code: '💻',
  vision: '👁️',
  extraction: '🧠',
  editor: '🎬',
  editor_vision: '👁️',
};

const DEFAULTS: ModelAssignments = {
  chat_thinking: 'qwen3:4b',
  chat_fast: 'qwen2.5:3b',
  code: 'qwen2.5-coder:7b',
  vision: 'qwen2.5vl:3b',
  extraction: 'qwen2.5:3b',
  editor: 'qwen2.5:3b',
  editor_vision: 'qwen2.5vl:3b',
};

/** Env-var names for legacy backward compatibility */
const ENV_MAP: Record<keyof ModelAssignments, string> = {
  chat_thinking: 'CHAT_THINKING_MODEL',
  chat_fast: 'CHAT_FAST_MODEL',
  code: 'CODE_MODEL',
  vision: 'VISION_MODEL',
  extraction: 'EXTRACTOR_MODEL',
  editor: 'EDITOR_MODEL',
  editor_vision: 'EDITOR_VISION_MODEL',
};

/**
 * Get the assigned model for a given category.
 * Priority: settings file > env var > hardcoded default.
 */
export async function getModelAssignment(category: keyof ModelAssignments): Promise<string> {
  // 1. Check settings file first
  try {
    const data = await fs.readFile(SETTINGS_FILE, 'utf-8');
    const settings = JSON.parse(data);
    if (settings.modelAssignments?.[category]) {
      return settings.modelAssignments[category];
    }
  } catch {
    // File doesn't exist or parse error — fall through
  }

  // 2. Check legacy env var
  const envVar = ENV_MAP[category];
  if (envVar && process.env[envVar]) {
    return process.env[envVar]!;
  }

  // 3. Fall back to hardcoded default
  return DEFAULTS[category];
}


