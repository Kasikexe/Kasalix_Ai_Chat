export type Role = 'user' | 'assistant' | 'system';
export type ConversationMode = 'chat' | 'agent' | 'editor';

export interface Message {
  role: Role;
  content: string;
  timestamp?: number;
  durationMs?: number;
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
  changeType: 'created' | 'edited';
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
  chat_thinking: string;
  chat_fast: string;
  code: string;
  vision: string;
  extraction: string;
  editor: string;
  editor_vision: string;
  search: string;
  image_generation: string;
}

