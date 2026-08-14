export type Role = 'user' | 'assistant' | 'system';
export type ConversationMode = 'chat' | 'agent';

/** Serializable agent-loop state saved when a run is stopped/capped, so a later message can resume. */
export interface AgentResumeState {
  history: { role: string; content: string }[];
}

export interface Message {
  role: Role;
  content: string;
  timestamp?: number;
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
  /** Agent loop state saved when a run is stopped/capped — lets "continue" resume instead of restarting. */
  agentState?: AgentResumeState | null;
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

export interface ChatRequest {
  model: string;
  messages: Message[];
  conversationId?: string;
}

export interface MemoryData {
  enabled: boolean;
  categories: Record<string, Record<string, string>>;
  updatedAt: number;
}

export interface SessionInfo {
  authenticated: boolean;
  userId?: string;
}

export type Variables = {
  user: { id: string };
  auth: { authenticated: boolean };
  session: SessionInfo;
};
