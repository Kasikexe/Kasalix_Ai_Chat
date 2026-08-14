import { promises as fs } from 'fs';
import path from 'path';
import { getDataDir } from '../utils/helpers';

const SETTINGS_FILE = path.join(getDataDir(), 'settings.json');

/**
 * All assignable model roles in the app.
 * Keys map to UI categories; values are Ollama model names (e.g. "qwen3:4b").
 *
 * The "chat" role is the base chat model. When it supports thinking, the
 * thinking toggle (think flag) is applied on that one model. When it does NOT
 * support thinking, "chat_thinking" is the dedicated thinking model the client
 * switches to while the toggle is on.
 */
export interface ModelAssignments {
  chat: string;
  chat_thinking: string;
  code: string;
  vision: string;
  extraction: string;
  search: string;
  image_generation: string;
}

export const ASSIGNMENT_KEYS: (keyof ModelAssignments)[] = [
  'chat',
  'chat_thinking',
  'code',
  'vision',
  'extraction',
  'search',
  'image_generation',
];

export const ASSIGNMENT_LABELS: Record<keyof ModelAssignments, string> = {
  chat: 'Chat',
  chat_thinking: 'Chat (Thinking)',
  code: 'Code Generation',
  vision: 'Vision Analysis',
  extraction: 'Memory Extraction',
  search: 'Web Search',
  image_generation: 'Image Generation',
};

export const ASSIGNMENT_ICONS: Record<keyof ModelAssignments, string> = {
  chat: '💬',
  chat_thinking: '🧠',
  code: '💻',
  vision: '👁️',
  extraction: '🧠',
  search: '🌐',
  image_generation: '🎨',
};

const DEFAULTS: ModelAssignments = {
  chat: 'qwen3:4b',
  chat_thinking: 'qwen3:4b',
  code: 'qwen2.5-coder:7b',
  vision: 'qwen2.5vl:3b',
  extraction: 'qwen2.5:3b',
  search: 'qwen2.5:3b',
  image_generation: 'x/flux2-klein',
};

/** Env-var names for legacy backward compatibility */
const ENV_MAP: Record<keyof ModelAssignments, string> = {
  chat: 'CHAT_MODEL',
  chat_thinking: 'CHAT_THINKING_MODEL',
  code: 'CODE_MODEL',
  vision: 'VISION_MODEL',
  extraction: 'EXTRACTOR_MODEL',
  search: 'SEARCH_MODEL',
  image_generation: 'IMAGE_GENERATION_MODEL',
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
    const ma = settings.modelAssignments;
    // An EXPLICIT value wins — even an empty string, which the host uses to
    // set a category to "none" (no default fallback for those).
    if (ma && typeof ma[category] === 'string') {
      return ma[category];
    }
    // Backward compatibility: older settings stored separate thinking/fast
    // chat models — migrate the old "thinking" choice to the single chat role.
    if (category === 'chat') {
      if (ma?.chat_thinking) {
        return ma.chat_thinking;
      }
      if (ma?.chat_fast) {
        return ma.chat_fast;
      }
    }
  } catch {
    // File doesn't exist or parse error — fall through
  }

  // 2. Check legacy env var
  const envVar = ENV_MAP[category];
  if (envVar && process.env[envVar]) {
    return process.env[envVar]!;
  }
  // Backward compatibility: legacy env vars for the old chat split
  if (category === 'chat') {
    if (process.env.CHAT_THINKING_MODEL) {
      return process.env.CHAT_THINKING_MODEL;
    }
    if (process.env.CHAT_FAST_MODEL) {
      return process.env.CHAT_FAST_MODEL;
    }
  }

  // 3. Fall back to hardcoded default
  return DEFAULTS[category];
}
