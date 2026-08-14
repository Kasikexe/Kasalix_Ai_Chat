export type Role = 'user' | 'assistant' | 'system';
export type ConversationMode = 'chat' | 'agent';

export interface Message {
  role: Role;
  content: string;
  timestamp?: number;
  durationMs?: number;
  /** Reasoning/thinking text from models like qwen3, deepseek-r1 (collapsible in UI) */
  thinking?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  model: string;
  mode: ConversationMode;
  workspacePath?: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
}

export interface OllamaModel {
  name: string;
  size?: number;
  modified_at?: string;
  digest?: string;
  /** Whether the model family supports the think flag (qwen3, deepseek-r1, etc.) */
  supportsThinking?: boolean;
  details?: {
    format?: string;
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface ModifiedFile {
  filePath: string;
  fileName: string;
  changeType: 'created' | 'edited' | 'deleted';
  originalContent?: string;
  timestamp: number;
}

export interface UserProfile {
  id: string;
  name: string;
  color: string;
}

export interface MemoryData {
  enabled: boolean;
  categories: Record<string, Record<string, string>>;
  updatedAt: number;
}

export interface ModelAssignments {
  [key: string]: string;
  chat: string;
  chat_thinking: string;
  code: string;
  vision: string;
  extraction: string;
  search: string;
  image_generation: string;
}

