import type { Conversation, Message, OllamaModel } from '../types';

const API_BASE = '/api';

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface AppSettings {
  hiddenModels: string[];
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

// Build fetch options with the user ID injected as a cookie
function authedFetch(url: string, options: RequestInit = {}): RequestInit {
  const profile = loadProfile();
  const headers = new Headers(options.headers);
  options.credentials = 'include';

  if (profile?.id) {
    headers.set('X-User-Id', profile.id);
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

  async createConversation(model: string, title?: string): Promise<Conversation> {
    const data = await handleResponse<{ conversation: Conversation }>(
      await fetch(`${API_BASE}/conversations`, authedFetch(`${API_BASE}/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, title }),
      }))
    );
    return data.conversation;
  },

  async updateConversation(
    id: string,
    updates: { title?: string; model?: string }
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

  async getSettings(): Promise<AppSettings> {
    return handleResponse<AppSettings>(
      await fetch(`${API_BASE}/settings`, authedFetch(`${API_BASE}/settings`))
    );
  },

  async saveSettings(hiddenModels: string[]): Promise<AppSettings> {
    return handleResponse<AppSettings>(
      await fetch(`${API_BASE}/settings`, authedFetch(`${API_BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hiddenModels }),
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
  signal?: AbortSignal
): Promise<void> {
  return (async () => {
    const res = await fetch(`${API_BASE}/chat`, authedFetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        conversationId,
        thinkingEnabled: localStorage.getItem('ai-chat:thinkingEnabled') === 'true',
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

};
