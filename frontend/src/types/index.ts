export type Role = 'user' | 'assistant' | 'system' | 'activity';
export type ConversationMode = 'chat' | 'agent';

/** A single event in the agent's execution timeline (thinking, tool call, etc.) */
export type TimelineEvent =
  | { type: 'thinking'; content: string }
  | { type: 'narration'; content: string }
  | { type: 'tool'; tool: string; args: string; status?: 'running' | 'done' | 'error'; result?: string; ok?: boolean };

/** A page a web search actually used, shown under the answer as a link. */
export interface SearchSource {
  title: string;
  url: string;
}

export interface Message {
  role: Role;
  content: string;
  timestamp?: number;
  durationMs?: number;
  /** Reasoning/thinking text from models like qwen3, deepseek-r1 (collapsible in UI) */
  thinking?: string;
  /** Ordered timeline of thinking + tool events during agent execution */
  timeline?: TimelineEvent[];
  /** Real generation stats from Ollama (tokens/s) for the meta line */
  tokensPerSecond?: number;
  /** Tokens generated for this reply (from Ollama's eval_count) */
  evalCount?: number;
  /** Which model generated this response */
  generatedBy?: string;
  /** Whether the model is local or cloud */
  modelSource?: 'local' | 'cloud';
  /** For activity messages: tool name */
  activityTool?: string;
  /** For activity messages: tool args summary */
  activityArgs?: string;
  /** For activity messages: success/error status */
  activityStatus?: 'running' | 'done' | 'error';
  /** For activity messages: elapsed time */
  activityMs?: number;
  /** Pages the web search used for this reply (source links under the answer) */
  sources?: SearchSource[];
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
}

