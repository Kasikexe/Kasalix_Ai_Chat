export type Role = 'user' | 'assistant' | 'system';
export type ConversationMode = 'chat' | 'agent';

export interface Message {
  role: Role;
  content: string;
  timestamp?: number;
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

