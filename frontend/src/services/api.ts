import type { Conversation, ConversationMode, Message, OllamaModel, FileEntry, MemoryData } from '../types';

// ─── Server URL Configuration ────────────────────────────
// On desktop (Electron / browser dev), the Vite proxy handles '/api' -> 'localhost:3001'.
// On Android (Capacitor), there's no proxy — the app needs the PC's local IP.
const SERVER_URL_KEY = 'ai-chat:serverUrl';

export function getApiBaseUrl(): string {
  // Check for a saved custom server URL (used on Android)
  try {
    const saved = localStorage.getItem(SERVER_URL_KEY);
    if (saved) {
      const url = saved.trim().replace(/\/+$/, ''); // Remove trailing slash
      return `${url}/api`;
    }
  } catch {}
  // Default: use proxy (works in Electron and Vite dev)
  return '/api';
}

export function getSavedServerUrl(): string | null {
  try {
    return localStorage.getItem(SERVER_URL_KEY);
  } catch { return null; }
}

export function saveServerUrl(url: string): void {
  localStorage.setItem(SERVER_URL_KEY, url.trim().replace(/\/+$/, ''));
}

export function clearServerUrl(): void {
  localStorage.removeItem(SERVER_URL_KEY);
}

export function isInCapacitor(): boolean {
  try {
    // Check for Capacitor runtime (standard)
    if (typeof (window as any).Capacitor !== 'undefined') {
      // isNativePlatform might be a function or a boolean depending on version
      const cap = (window as any).Capacitor;
      if (typeof cap.isNativePlatform === 'function') {
        return cap.isNativePlatform() === true;
      }
      if (cap.isNative === true) return true;
    }
    // Check for Android WebView (Capacitor runs in a WebView)
    const ua = navigator.userAgent || '';
    if (ua.includes('Android') && ua.includes('wv')) {
      return true;
    }
    // Check for Capacitor-specific bridge
    if (typeof (window as any).androidBridge !== 'undefined') return true;
    if (typeof (window as any).CapacitorCookies !== 'undefined') return true;
    if (typeof (window as any).CapacitorWebView !== 'undefined') return true;
    return false;
  } catch {
    return false;
  }
}

const API_BASE = getApiBaseUrl();

// ─── Electron Detection ───────────────────────────────────
const isElectron = !!(window as any).electronAPI?.isElectron;

/** Call Electron IPC for file operations when in the desktop app */
function electronFileOp(op: string, ...args: any[]): Promise<any> {
  const api = (window as any).electronAPI;
  if (!api || !api[op]) throw new Error(`Electron API not available for ${op}`);
  return api[op](...args);
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface ModelAssignments {
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

export const MODEL_ASSIGNMENT_KEYS: (keyof ModelAssignments)[] = [
  'chat_thinking',
  'chat_fast',
  'code',
  'vision',
  'extraction',
  'editor',
  'editor_vision',
  'search',
  'image_generation',
];

export const MODEL_ASSIGNMENT_LABELS: Record<keyof ModelAssignments, string> = {
  chat_thinking: 'Chat (Thinking)',
  chat_fast: 'Chat (Fast)',
  code: 'Code Generation',
  vision: 'Vision Analysis',
  extraction: 'Memory Extraction',
  editor: 'Video Editor',
  editor_vision: 'Editor Vision',
  search: 'Web Search',
  image_generation: 'Image Generation',
};

export const MODEL_ASSIGNMENT_ICONS: Record<keyof ModelAssignments, string> = {
  chat_thinking: '🧠',
  chat_fast: '⚡',
  code: '💻',
  vision: '👁️',
  extraction: '🧠',
  editor: '🎬',
  editor_vision: '👁️',
  search: '🌐',
  image_generation: '🎨',
};

export interface AppSettings {
  hiddenModels: string[];
  modelAssignments?: Record<string, string>;
  updatedAt: number;
}

export interface UserProfile {
  id: string;
  name: string;
  color: string;
}

const USER_KEY = 'ai-chat:userProfile';

function loadProfile(): UserProfile | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveProfile(profile: UserProfile): void {
  localStorage.setItem(USER_KEY, JSON.stringify(profile));
}

const COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
];

function pickColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

function hashName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash |= 0;
  }
  return 'user_' + Math.abs(hash).toString(36) + '_' + name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function getUserProfile(): UserProfile | null {
  return loadProfile();
}

export function createUserProfile(name: string): UserProfile {
  const cleanName = name.trim();
  const profile: UserProfile = {
    id: hashName(cleanName),
    name: cleanName,
    color: pickColor(cleanName),
  };
  saveProfile(profile);
  return profile;
}

export function updateUserProfile(updates: Partial<UserProfile>): UserProfile {
  const current = loadProfile();
  if (!current) throw new Error('No profile to update');
  const next = { ...current, ...updates };
  saveProfile(next);
  return next;
}

export function clearUserProfile(): void {
  localStorage.removeItem(USER_KEY);
}

// Session token management
const TOKEN_KEY = 'ai-chat:sessionToken';

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch { return null; }
}

export function setSessionToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearSessionToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function isLoggedIn(): boolean {
  return !!getSessionToken();
}

// Build fetch options with the user ID injected + Bearer token for session auth
function authedFetch(url: string, options: RequestInit = {}): RequestInit {
  const profile = loadProfile();
  const headers = new Headers(options.headers);
  options.credentials = 'include';

  if (profile?.id) {
    headers.set('X-User-Id', profile.id);
  }

  // Add Bearer token for session-based auth
  const token = getSessionToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  return { ...options, headers };
}


export const api = {
  async getModels(): Promise<OllamaModel[]> {
    const data = await handleResponse<{ models: OllamaModel[] }>(
      await fetch(`${API_BASE}/models`, authedFetch(`${API_BASE}/models`))
    );
    return data.models;
  },

  async getConversations(): Promise<Conversation[]> {
    const data = await handleResponse<{ conversations: Conversation[] }>(
      await fetch(`${API_BASE}/conversations`, authedFetch(`${API_BASE}/conversations`))
    );
    return data.conversations;
  },

  async getConversation(id: string): Promise<Conversation> {
    const data = await handleResponse<{ conversation: Conversation }>(
      await fetch(`${API_BASE}/conversations/${id}`, authedFetch(`${API_BASE}/conversations/${id}`))
    );
    return data.conversation;
  },

  async createConversation(model: string, title?: string, mode?: ConversationMode, workspacePath?: string): Promise<Conversation> {
    const data = await handleResponse<{ conversation: Conversation }>(
      await fetch(`${API_BASE}/conversations`, authedFetch(`${API_BASE}/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, title, mode, workspacePath }),
      }))
    );
    return data.conversation;
  },

  async updateConversation(
    id: string,
    updates: { title?: string; model?: string; mode?: ConversationMode; workspacePath?: string }
  ): Promise<Conversation> {
    const data = await handleResponse<{ conversation: Conversation }>(
      await fetch(`${API_BASE}/conversations/${id}`, authedFetch(`${API_BASE}/conversations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      }))
    );
    return data.conversation;
  },

  async deleteConversation(id: string): Promise<void> {
    await handleResponse(
      await fetch(`${API_BASE}/conversations/${id}`, authedFetch(`${API_BASE}/conversations/${id}`, {
        method: 'DELETE',
      }))
    );
  },

  async addConversationMessage(
    id: string,
    role: 'user' | 'assistant',
    content: string
  ): Promise<Conversation> {
    const data = await handleResponse<{ conversation: Conversation }>(
      await fetch(`${API_BASE}/conversations/${id}/messages`, authedFetch(`${API_BASE}/conversations/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, content }),
      }))
    );
    return data.conversation;
  },

  async deleteConversationMessage(id: string, messageIndex: number): Promise<Conversation> {
    const data = await handleResponse<{ conversation: Conversation }>(
      await fetch(`${API_BASE}/conversations/${id}/messages/${messageIndex}`, authedFetch(`${API_BASE}/conversations/${id}/messages/${messageIndex}`, {
        method: 'DELETE',
      }))
    );
    return data.conversation;
  },

  async getSettings(): Promise<AppSettings> {
    return handleResponse<AppSettings>(
      await fetch(`${API_BASE}/settings`, authedFetch(`${API_BASE}/settings`))
    );
  },

  async saveSettings(payload: { hiddenModels?: string[]; modelAssignments?: Record<string, string> }): Promise<AppSettings> {
    return handleResponse<AppSettings>(
      await fetch(`${API_BASE}/settings`, authedFetch(`${API_BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }))
    );
  },

  async resetSettings(): Promise<AppSettings> {
    return handleResponse<AppSettings>(
      await fetch(`${API_BASE}/settings/reset`, authedFetch(`${API_BASE}/settings/reset`, {
        method: 'POST',
      }))
    );
  },

  async isAuthenticated(): Promise<boolean> {
    try {
      const data = await handleResponse<{ authenticated: boolean }>(
        await fetch(`${API_BASE}/settings/auth`, authedFetch(`${API_BASE}/settings/auth`))
      );
      return data.authenticated;
    } catch {
      return false;
    }
  },

  async authenticate(password: string): Promise<boolean> {
    try {
      const res = await fetch(`${API_BASE}/settings/auth`, authedFetch(`${API_BASE}/settings/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      }));
      return res.ok;
    } catch {
      return false;
    }
  },

  // ─── User Authentication ────────────────────────────────
  async register(username: string, password: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return { success: false, error: data.error || 'Registration failed' };
      }
      const data = await res.json();
      if (data.token) {
        setSessionToken(data.token);
        // Ensure user profile is set
        if (data.user) {
          const current = loadProfile();
          if (!current || current.id !== data.user.id) {
            saveProfile({ id: data.user.id, name: data.user.username, color: data.user.color });
          }
        }
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: 'Connection failed' };
    }
  },

  async login(username: string, password: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return { success: false, error: data.error || 'Invalid username or password' };
      }
      const data = await res.json();
      if (data.token) {
        setSessionToken(data.token);
        if (data.user) {
          const current = loadProfile();
          if (!current || current.id !== data.user.id) {
            saveProfile({ id: data.user.id, name: data.user.username, color: data.user.color });
          }
        }
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: 'Connection failed' };
    }
  },

  async checkSession(): Promise<{ authenticated: boolean; user?: UserProfile }> {
    try {
      const data = await handleResponse<{ authenticated: boolean; user?: { id: string; username: string; color: string } }>(
        await fetch(`${API_BASE}/auth/me`, authedFetch(`${API_BASE}/auth/me`))
      );
      if (data.authenticated && data.user) {
        return {
          authenticated: true,
          user: { id: data.user.id, name: data.user.username, color: data.user.color },
        };
      }
      return { authenticated: false };
    } catch {
      return { authenticated: false };
    }
  },

  async logout(): Promise<void> {
    try {
      await fetch(`${API_BASE}/auth/logout`, authedFetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
      }));
    } catch { /* ignore */ }
    clearSessionToken();
    clearUserProfile();
  },

  /** List files in a directory — uses local IPC in Electron, backend API on web */
  async getFiles(dirPath: string): Promise<{ entries: FileEntry[] }> {
    if (isElectron) {
      return electronFileOp('listDir', dirPath);
    }
    const data = await handleResponse<{ entries: FileEntry[] }>(
      await fetch(`${API_BASE}/files?path=${encodeURIComponent(dirPath)}`, authedFetch(`${API_BASE}/files`))
    );
    return data;
  },

  /** Read file content — uses local IPC in Electron, backend API on web */
  async getFileContent(filePath: string): Promise<{
    content: string | null;
    language: string | null;
    size: number;
    truncated: boolean;
    binary: boolean;
  }> {
    if (isElectron) {
      const result = await electronFileOp('readFile', filePath);
      // Normalize: if IPC returned an error, treat as file doesn't exist
      const normalized = {
        content: result.content ?? null,
        binary: result.binary ?? false,
        size: result.size ?? 0,
        truncated: result.truncated ?? false,
        language: result.language ?? null,
      };
      // Add language detection from file extension
      if (!normalized.language && !normalized.binary && normalized.content !== null) {
        const ext = filePath.split('.').pop()?.toLowerCase();
        const langMap: Record<string, string> = {
          ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
          json: 'json', md: 'markdown', css: 'css', scss: 'scss',
          html: 'html', py: 'python', go: 'go', rs: 'rust',
          sh: 'bash', yaml: 'yaml', yml: 'yaml', xml: 'xml',
        };
        normalized.language = ext ? langMap[ext] || null : null;
      }
      return normalized;
    }
    return handleResponse(
      await fetch(`${API_BASE}/files/content?path=${encodeURIComponent(filePath)}`, authedFetch(`${API_BASE}/files`))
    );
  },

  /** Delete a file — uses local IPC in Electron, backend API on web */
  async deleteFile(filePath: string): Promise<{ success: boolean; path: string }> {
    if (isElectron) {
      return electronFileOp('deleteFile', filePath);
    }
    return handleResponse(
      await fetch(`${API_BASE}/files/delete?path=${encodeURIComponent(filePath)}`, authedFetch(`${API_BASE}/files/delete`, {
        method: 'DELETE',
      }))
    );
  },

  /** Write content to a file — uses local IPC in Electron, backend API on web */
  async writeFile(filePath: string, content: string): Promise<{ success: boolean; path: string; isNew: boolean; size: number }> {
    if (isElectron) {
      return electronFileOp('writeFile', filePath, content);
    }
    return handleResponse(
      await fetch(`${API_BASE}/files/write`, authedFetch(`${API_BASE}/files/write`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, content }),
      }))
    );
  },

  async generateTitle(message: string, model: string): Promise<string> {
    try {
      const data = await handleResponse<{ title: string }>(
        await fetch(`${API_BASE}/chat/title`, authedFetch(`${API_BASE}/chat/title`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, model }),
        }))
      );
      return data.title;
    } catch {
      return 'New Chat';
    }
  },

streamChat(
  model: string,
  messages: Message[],
  conversationId: string | undefined,
  callbacks: {
    onChunk: (chunk: string) => void;
    onConversationId: (id: string) => void;
    onStage: (stage: string) => void;
    onDone: () => void;
    onError: (err: string) => void;
  },
  signal?: AbortSignal,
  mode?: ConversationMode,
  workspacePath?: string,
  temperature?: number,
  top_p?: number,
  max_tokens?: number,
  planningEnabled?: boolean
): Promise<void> {
  return (async () => {
    const profile = loadProfile();
    const res = await fetch(`${API_BASE}/chat`, authedFetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        conversationId,
        mode,
        workspacePath,
        thinkingEnabled: localStorage.getItem('ai-chat:thinkingEnabled') === 'true',
        searchEnabled: true,
        temperature,
        top_p,
        max_tokens,
        userName: profile?.name || 'User',
        planningEnabled: planningEnabled === true,
      }),
      signal,
    }));



      if (!res.ok || !res.body) {
        callbacks.onError(`Chat request failed: ${res.statusText}`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() || '';

          for (const evt of events) {
            const line = evt.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const parsed = JSON.parse(payload);
              switch (parsed.type) {
                case 'chunk': callbacks.onChunk(parsed.content); break;
                case 'conversationId': callbacks.onConversationId(parsed.conversationId); break;
                case 'stage': callbacks.onStage(parsed.stage); break;
                case 'done': callbacks.onDone(); return;
                case 'error': callbacks.onError(parsed.error); return;
              }
            } catch (e) {
              console.error('SSE parse error:', e);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    })();
  },

  // --- Editor API ---
  async getVideoInfo(filePath: string): Promise<{
    fileName: string;
    fileSize: number;
    duration: number;
    bitRate: number;
    format: string;
    video: {
      codec: string;
      width: number;
      height: number;
      fps: number;
      pixelFormat: string;
    } | null;
    audio: {
      codec: string;
      sampleRate: number;
      channels: number;
    } | null;
    streams: number;
  }> {
    const data = await handleResponse<{ info: any }>(
      await fetch(`${API_BASE}/editor/info`, authedFetch(`${API_BASE}/editor/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      }))
    );
    return data.info;
  },

  async extractFrame(
    filePath: string,
    time: number,
    width: number = 640
  ): Promise<{ frame: string; time: number; width: number }> {
    const data = await handleResponse<{ frame: string; time: number; width: number }>(
      await fetch(`${API_BASE}/editor/frames`, authedFetch(`${API_BASE}/editor/frames`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, time, width }),
      }))
    );
    return data;
  },

  async renderVideo(
    inputPath: string,
    outputFileName: string,
    cmdArgs: string
  ): Promise<{ success: boolean; outputPath: string; outputFileName: string; outputSize: number; elapsed: number }> {
    const data = await handleResponse<any>(
      await fetch(`${API_BASE}/editor/render`, authedFetch(`${API_BASE}/editor/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputPath, outputFileName, cmdArgs }),
      }))
    );
    return data;
  },

  editorChat(
    message: string,
    videoPath: string | null,
    videoInfo: any,
    messages: { role: 'user' | 'assistant'; content: string }[],
    callbacks: {
      onChunk: (chunk: string) => void;
      onCommand: (args: string, auto?: boolean) => void;
      onDone: () => void;
      onError: (err: string) => void;
      onStage?: (stage: string) => void;
    },
    signal?: AbortSignal
  ): Promise<void> {
    return (async () => {
      const res = await fetch(`${API_BASE}/editor/chat`, authedFetch(`${API_BASE}/editor/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, videoPath, videoInfo, messages }),
        signal,
      }));

      if (!res.ok || !res.body) {
        callbacks.onError(`Editor chat failed: ${res.statusText}`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() || '';

          for (const evt of events) {
            const line = evt.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const parsed = JSON.parse(payload);
              switch (parsed.type) {
                case 'chunk': callbacks.onChunk(parsed.content); break;
                case 'command': callbacks.onCommand(parsed.args, parsed.auto); break;
                case 'stage': callbacks.onStage?.(parsed.stage); break;
                case 'done': callbacks.onDone(); return;
                case 'error': callbacks.onError(parsed.error); return;
              }
            } catch (e) {
              console.error('SSE parse error:', e);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    })();
  },

  async uploadVideo(file: File): Promise<{ fileName: string; filePath: string; size: number }> {
    const formData = new FormData();
    formData.append('file', file);
    const data = await handleResponse<{ fileName: string; filePath: string; size: number }>(
      await fetch(`${API_BASE}/editor/upload`, authedFetch(`${API_BASE}/editor/upload`, {
        method: 'POST',
        body: formData,
      }))
    );
    return data;
  },

  // --- Generated Images API ---
  getGeneratedImageUrl(filename: string): string {
    return `/api/generated/${filename}`;
  },

  downloadGeneratedImage(filename: string): void {
    const a = document.createElement('a');
    a.href = `/api/generated/${filename}/download`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  async saveGeneratedImageToWorkspace(filename: string, workspacePath: string): Promise<{ success: boolean; path: string; filename: string }> {
    return handleResponse(
      await fetch(`${API_BASE}/generated/${filename}/save-to-workspace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath }),
      })
    );
  },

  // --- Folder Dialog (Electron only) ---
  async openFolderDialog(): Promise<{ canceled: boolean; path?: string; name?: string; error?: string }> {
    if (!isElectron) return { canceled: true, error: 'Not available in browser' };
    return electronFileOp('openFolderDialog');
  },

  // --- Planned Features API ---
  async getPlannedFeatures(): Promise<{ features: any[] }> {
    return handleResponse<{ features: any[] }>(
      await fetch(`${API_BASE}/planned`, authedFetch(`${API_BASE}/planned`))
    );
  },

  async addPlannedFeature(feature: { title: string; description: string; status?: string; icon?: string }): Promise<{ feature: any }> {
    return handleResponse<{ feature: any }>(
      await fetch(`${API_BASE}/planned`, authedFetch(`${API_BASE}/planned`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feature),
      }))
    );
  },

  async updatePlannedFeature(id: string, updates: { title?: string; description?: string; status?: string; icon?: string; order?: number }): Promise<{ feature: any }> {
    return handleResponse<{ feature: any }>(
      await fetch(`${API_BASE}/planned/${encodeURIComponent(id)}`, authedFetch(`${API_BASE}/planned/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      }))
    );
  },

  async deletePlannedFeature(id: string): Promise<{ success: boolean }> {
    return handleResponse<{ success: boolean }>(
      await fetch(`${API_BASE}/planned/${encodeURIComponent(id)}`, authedFetch(`${API_BASE}/planned/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }))
    );
  },



  // --- Changelog API ---
  async getChangelog(): Promise<{ entries: any[] }> {
    return handleResponse<{ entries: any[] }>(
      await fetch(`${API_BASE}/changelog`, authedFetch(`${API_BASE}/changelog`))
    );
  },

  async addChangelogEntry(entry: { version: string; title: string; description: string; type: string }): Promise<{ entry: any }> {
    return handleResponse<{ entry: any }>(
      await fetch(`${API_BASE}/changelog`, authedFetch(`${API_BASE}/changelog`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      }))
    );
  },

  async deleteChangelogEntry(version: string): Promise<{ success: boolean }> {
    return handleResponse<{ success: boolean }>(
      await fetch(`${API_BASE}/changelog/${encodeURIComponent(version)}`, authedFetch(`${API_BASE}/changelog/${encodeURIComponent(version)}`, {
        method: 'DELETE',
      }))
    );
  },

  // --- Changelog Draft API ---
  async getChangelogDraft(): Promise<{ draft: { description: string; autoSavedAt: number } }> {
    return handleResponse(
      await fetch(`${API_BASE}/changelog/draft`, authedFetch(`${API_BASE}/changelog/draft`))
    );
  },

  async saveChangelogDraft(description: string): Promise<{ draft: { description: string; autoSavedAt: number } }> {
    return handleResponse(
      await fetch(`${API_BASE}/changelog/draft`, authedFetch(`${API_BASE}/changelog/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      }))
    );
  },

  async publishChangelogDraft(version: string, title: string, type: string): Promise<{ entry: any }> {
    return handleResponse(
      await fetch(`${API_BASE}/changelog/draft/publish`, authedFetch(`${API_BASE}/changelog/draft/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, title, type }),
      }))
    );
  },

  // --- Terminal API ---
  async executeTerminal(
    command: string,
    cwd?: string
  ): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    code: number;
    killed?: boolean;
    timeout?: boolean;
  }> {
    return handleResponse(
      await fetch(`${API_BASE}/terminal`, authedFetch(`${API_BASE}/terminal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, cwd }),
      }))
    );
  },

  // --- Speed Test API ---
  async getSpeedTestTests(): Promise<{ id: string; name: string; description: string; category: string }[]> {
    const data = await handleResponse<{ tests: any[] }>(
      await fetch(`${API_BASE}/speedtest/tests`, authedFetch(`${API_BASE}/speedtest/tests`))
    );
    return data.tests;
  },

  async runSpeedTests(): Promise<{ result: any }> {
    return handleResponse<{ result: any }>(
      await fetch(`${API_BASE}/speedtest/run`, authedFetch(`${API_BASE}/speedtest/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }))
    );
  },

  async getSpeedTestResults(): Promise<{ results: any[] }> {
    return handleResponse<{ results: any[] }>(
      await fetch(`${API_BASE}/speedtest/results`, authedFetch(`${API_BASE}/speedtest/results`))
    );
  },

  async deleteSpeedTestResult(id: string): Promise<{ success: boolean }> {
    return handleResponse<{ success: boolean }>(
      await fetch(`${API_BASE}/speedtest/results/${encodeURIComponent(id)}`, authedFetch(`${API_BASE}/speedtest/results/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }))
    );
  },

  // --- Memory API ---
  async getMemory(): Promise<MemoryData> {
    return handleResponse<MemoryData>(
      await fetch(`${API_BASE}/memory`, authedFetch(`${API_BASE}/memory`))
    );
  },

  async updateMemory(updates: Partial<MemoryData> & { categories?: Record<string, Record<string, string>> }): Promise<MemoryData> {
    return handleResponse<MemoryData>(
      await fetch(`${API_BASE}/memory`, authedFetch(`${API_BASE}/memory`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      }))
    );
  },

  async resetMemory(): Promise<MemoryData> {
    return handleResponse<MemoryData>(
      await fetch(`${API_BASE}/memory`, authedFetch(`${API_BASE}/memory`, {
        method: 'DELETE',
      }))
    );
  },
};
