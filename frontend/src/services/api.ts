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

function pickColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

export function getUserProfile(): UserProfile | null {
  return loadProfile();
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older browsers / insecure contexts
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  );
}

export function createUserProfile(name: string): UserProfile {
  const profile: UserProfile = {
    id: generateId(),
    name: name.trim(),
    color: pickColor(),
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

export const api = {
  async getModels(): Promise<OllamaModel[]> {
    const data = await handleResponse<{ models: OllamaModel[] }>(
      await fetch(`${API_BASE}/models`, { credentials: 'include' })
    );
    return data.models;
  },

  async getConversations(): Promise<Conversation[]> {
    const data = await handleResponse<{ conversations: Conversation[] }>(
      await fetch(`${API_BASE}/conversations`, { credentials: 'include' })
    );
    return data.conversations;
  },

  async getConversation(id: string): Promise<Conversation> {
    const data = await handleResponse<{ conversation: Conversation }>(
      await fetch(`${API_BASE}/conversations/${id}`, { credentials: 'include' })
    );
    return data.conversation;
  },

  async createConversation(model: string, title?: string): Promise<Conversation> {
    const data = await handleResponse<{ conversation: Conversation }>(
      await fetch(`${API_BASE}/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, title }),
        credentials: 'include',
      })
    );
    return data.conversation;
  },

  async updateConversation(
    id: string,
    updates: { title?: string; model?: string }
  ): Promise<Conversation> {
    const data = await handleResponse<{ conversation: Conversation }>(
      await fetch(`${API_BASE}/conversations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
        credentials: 'include',
      })
    );
    return data.conversation;
  },

  async deleteConversation(id: string): Promise<void> {
    await handleResponse(
      await fetch(`${API_BASE}/conversations/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
    );
  },

  async getSettings(): Promise<AppSettings> {
    return handleResponse<AppSettings>(
      await fetch(`${API_BASE}/settings`, { credentials: 'include' })
    );
  },

  async saveSettings(hiddenModels: string[]): Promise<AppSettings> {
    return handleResponse<AppSettings>(
      await fetch(`${API_BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hiddenModels }),
        credentials: 'include',
      })
    );
  },

  async resetSettings(): Promise<AppSettings> {
    return handleResponse<AppSettings>(
      await fetch(`${API_BASE}/settings/reset`, {
        method: 'POST',
        credentials: 'include',
      })
    );
  },

  async isAuthenticated(): Promise<boolean> {
    try {
      const data = await handleResponse<{ authenticated: boolean }>(
        await fetch(`${API_BASE}/settings/auth`, { credentials: 'include' })
      );
      return data.authenticated;
    } catch {
      return false;
    }
  },

  async authenticate(password: string): Promise<boolean> {
    try {
      const res = await fetch(`${API_BASE}/settings/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'include',
      });
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
      onDone: () => void;
      onError: (err: string) => void;
    },
    signal?: AbortSignal
  ): Promise<void> {
    return (async () => {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, conversationId }),
        signal,
        credentials: 'include',
      });

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
