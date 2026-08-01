import { promises as fs } from 'fs';
import path from 'path';
import type { Conversation, ConversationMode, Message } from '../types';
import { generateId, truncate, getDataDir } from '../utils/helpers';

function migrate(conv: any): Conversation {
  return {
    ...conv,
    mode: conv.mode || 'chat',
    workspacePath: conv.workspacePath || undefined,
  };
}

const STORAGE_DIR = getDataDir();
const STORAGE_FILE = path.join(STORAGE_DIR, 'conversations.json');

let conversations: Map<string, Conversation> = new Map();
let initialized = false;

// ─── Debounced Writes (#8) ───────────────────────────────────
// Instead of writing to disk on EVERY message, debounce writes so rapid
// messages only trigger a single write. This saves 30-100ms per message.
const DEBOUNCE_MS = 500;
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

function debouncedSave(): void {
  // Always reset the timer — last call wins
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    try {
      await ensureDir();
      const obj = Object.fromEntries(conversations);
      await fs.writeFile(STORAGE_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {
      console.error('Failed to save conversations:', e);
    } finally {
      saveTimeout = null;
    }
  }, DEBOUNCE_MS);
}

/**
 * Force an immediate save (used before shutdown or critical operations).
 */
async function flushSave(): Promise<void> {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  try {
    await ensureDir();
    const obj = Object.fromEntries(conversations);
    await fs.writeFile(STORAGE_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('Failed to flush conversations:', e);
  }
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

async function loadFromFile(): Promise<void> {
  if (initialized) return;
  try {
    await ensureDir();
    const data = await fs.readFile(STORAGE_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    conversations = new Map(
      Object.entries(parsed).map(([k, v]) => [k, migrate(v)])
    );
  } catch {
    conversations = new Map();
  }
  initialized = true;
}

// Replaced by debouncedSave() and flushSave() above

export async function getAllConversations(ownerId?: string): Promise<Conversation[]> {
  await loadFromFile();
  const all = Array.from(conversations.values());
  const filtered = ownerId ? all.filter((c) => c.ownerId === ownerId) : all;
  return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConversation(id: string, ownerId?: string): Promise<Conversation | null> {
  await loadFromFile();
  const conv = conversations.get(id);
  if (!conv) return null;
  if (ownerId && conv.ownerId !== ownerId) return null;
  return conv;
}

export async function createConversation(
  model: string,
  ownerId: string,
  title?: string,
  mode: ConversationMode = 'chat',
  workspacePath?: string
): Promise<Conversation> {
  await loadFromFile();
  const now = Date.now();
  const conv: Conversation = {
    id: generateId(),
    title: title || (mode === 'agent' ? 'New Agent Session' : 'New Chat'),
    messages: [],
    model,
    ownerId,
    mode,
    workspacePath,
    createdAt: now,
    updatedAt: now,
  };
  conversations.set(conv.id, conv);
  debouncedSave();
  return conv;
}


export async function updateConversation(
  id: string,
  ownerId: string,
  updates: Partial<Pick<Conversation, 'title' | 'model' | 'mode' | 'workspacePath'>>
): Promise<Conversation | null> {
  await loadFromFile();
  const conv = conversations.get(id);
  if (!conv) return null;
  if (conv.ownerId !== ownerId) return null;
  const updated: Conversation = { ...conv, ...updates, updatedAt: Date.now() };
  conversations.set(id, updated);
  debouncedSave();
  return updated;
}

export async function deleteConversation(id: string, ownerId: string): Promise<boolean> {
  await loadFromFile();
  const conv = conversations.get(id);
  if (!conv) return false;
  if (conv.ownerId !== ownerId) return false;
  conversations.delete(id);
  flushSave(); // Flush immediately on delete — data safety
  return true;
}

export async function addMessage(
  conversationId: string,
  ownerId: string,
  message: Message
): Promise<Conversation | null> {
  await loadFromFile();
  const conv = conversations.get(conversationId);
  if (!conv) return null;
  if (conv.ownerId !== ownerId) return null;

  const messageWithTime = { ...message, timestamp: Date.now() };
  conv.messages.push(messageWithTime);
  conv.updatedAt = Date.now();

  if ((conv.title === 'New Chat' || conv.title === 'New Agent Session') && message.role === 'user' && conv.messages.length === 1) {
    conv.title = truncate(message.content, 50);
  }

  conversations.set(conversationId, conv);
  debouncedSave();
  return conv;
}

/**
 * Delete a single message by index from a conversation.
 */
export async function deleteMessage(
  conversationId: string,
  ownerId: string,
  messageIndex: number
): Promise<Conversation | null> {
  await loadFromFile();
  const conv = conversations.get(conversationId);
  if (!conv) return null;
  if (conv.ownerId !== ownerId) return null;
  if (messageIndex < 0 || messageIndex >= conv.messages.length) return null;

  conv.messages.splice(messageIndex, 1);
  conv.updatedAt = Date.now();

  conversations.set(conversationId, conv);
  debouncedSave();
  return conv;
}
