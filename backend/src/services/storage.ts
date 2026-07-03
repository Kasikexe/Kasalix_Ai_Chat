import { promises as fs } from 'fs';
import path from 'path';
import type { Conversation, Message } from '../types';
import { generateId, truncate } from '../utils/helpers';

const STORAGE_DIR = path.join(process.cwd(), 'data');
const STORAGE_FILE = path.join(STORAGE_DIR, 'conversations.json');

let conversations: Map<string, Conversation> = new Map();
let initialized = false;
let saveQueue: Promise<void> = Promise.resolve();

async function ensureDir(): Promise<void> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

async function loadFromFile(): Promise<void> {
  if (initialized) return;
  try {
    await ensureDir();
    const data = await fs.readFile(STORAGE_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    conversations = new Map(Object.entries(parsed));
  } catch {
    conversations = new Map();
  }
  initialized = true;
}

function saveToFile(): Promise<void> {
  saveQueue = saveQueue.then(async () => {
    try {
      await ensureDir();
      const obj = Object.fromEntries(conversations);
      await fs.writeFile(STORAGE_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {
      console.error('Failed to save conversations:', e);
    }
  });
  return saveQueue;
}

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
  title?: string
): Promise<Conversation> {
  await loadFromFile();
  const now = Date.now();
  const conv: Conversation = {
    id: generateId(),
    title: title || 'New Chat',
    messages: [],
    model,
    ownerId,
    createdAt: now,
    updatedAt: now,
  };
  conversations.set(conv.id, conv);
  await saveToFile();
  return conv;
}

export async function updateConversation(
  id: string,
  ownerId: string,
  updates: Partial<Pick<Conversation, 'title' | 'model'>>
): Promise<Conversation | null> {
  await loadFromFile();
  const conv = conversations.get(id);
  if (!conv) return null;
  if (conv.ownerId !== ownerId) return null;
  const updated: Conversation = { ...conv, ...updates, updatedAt: Date.now() };
  conversations.set(id, updated);
  await saveToFile();
  return updated;
}

export async function deleteConversation(id: string, ownerId: string): Promise<boolean> {
  await loadFromFile();
  const conv = conversations.get(id);
  if (!conv) return false;
  if (conv.ownerId !== ownerId) return false;
  conversations.delete(id);
  await saveToFile();
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

  if (conv.title === 'New Chat' && message.role === 'user' && conv.messages.length === 1) {
    conv.title = truncate(message.content, 50);
  }

  conversations.set(conversationId, conv);
  await saveToFile();
  return conv;
}
