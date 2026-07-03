import { useCallback, useEffect, useState } from 'react';
import type { Conversation } from '../types';
import { api } from '../services/api';

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getConversations();
      setConversations(data);
    } catch (e) {
      console.error('Failed to load conversations:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const create = useCallback(async (model: string, title?: string) => {
    const conv = await api.createConversation(model, title);
    setConversations((prev) => [conv, ...prev]);
    return conv;
  }, []);

  const remove = useCallback(async (id: string) => {
    await api.deleteConversation(id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const rename = useCallback(async (id: string, title: string) => {
    const updated = await api.updateConversation(id, { title });
    setConversations((prev) => prev.map((c) => (c.id === id ? updated : c)));
    return updated;
  }, []);

  const update = useCallback((conv: Conversation) => {
    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === conv.id);
      if (idx === -1) return [conv, ...prev];
      const next = [...prev];
      next[idx] = conv;
      return next.sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }, []);

  return { conversations, loading, refresh, create, remove, rename, update };
}
