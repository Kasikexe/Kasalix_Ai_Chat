import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import type { MemoryData } from '../types';

export function useMemory() {
  const [memory, setMemory] = useState<MemoryData>({
    enabled: false,
    categories: {},
    updatedAt: 0,
  });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getMemory();
      setMemory(data);
    } catch (e) {
      console.error('[useMemory] Failed to load:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggleMemory = useCallback(async () => {
    const next = !memory.enabled;
    try {
      const updated = await api.updateMemory({ enabled: next });
      setMemory(updated);
      return updated;
    } catch (e) {
      console.error('[useMemory] Failed to toggle:', e);
      return memory;
    }
  }, [memory]);

  const updateCategories = useCallback(
    async (categories: Record<string, Record<string, string>>) => {
      try {
        const updated = await api.updateMemory({ categories });
        setMemory(updated);
        return updated;
      } catch (e) {
        console.error('[useMemory] Failed to update categories:', e);
        return memory;
      }
    },
    [memory]
  );

  const resetMemory = useCallback(async () => {
    try {
      const updated = await api.resetMemory();
      setMemory(updated);
      return updated;
    } catch (e) {
      console.error('[useMemory] Failed to reset:', e);
      return memory;
    }
  }, [memory]);

  const addEntry = useCallback(
    async (category: string, key: string, value: string) => {
      const categories = { ...memory.categories };
      if (!categories[category]) {
        categories[category] = {};
      }
      categories[category] = { ...categories[category], [key]: value };
      return updateCategories(categories);
    },
    [memory, updateCategories]
  );

  const removeEntry = useCallback(
    async (category: string, key: string) => {
      const categories = { ...memory.categories };
      if (categories[category]) {
        const updated = { ...categories[category] };
        delete updated[key];
        if (Object.keys(updated).length === 0) {
          delete categories[category];
        } else {
          categories[category] = updated;
        }
      }
      return updateCategories(categories);
    },
    [memory, updateCategories]
  );

  const editEntry = useCallback(
    async (category: string, key: string, value: string) => {
      const categories = { ...memory.categories };
      if (!categories[category]) {
        categories[category] = {};
      }
      categories[category] = { ...categories[category], [key]: value };
      return updateCategories(categories);
    },
    [memory, updateCategories]
  );

  const addCategory = useCallback(
    async (category: string) => {
      if (memory.categories[category]) return memory;
      const categories = { ...memory.categories, [category]: {} };
      return updateCategories(categories);
    },
    [memory, updateCategories]
  );

  const removeCategory = useCallback(
    async (category: string) => {
      const categories = { ...memory.categories };
      delete categories[category];
      return updateCategories(categories);
    },
    [memory, updateCategories]
  );

  return {
    memory,
    loading,
    refresh,
    toggleMemory,
    updateCategories,
    resetMemory,
    addEntry,
    removeEntry,
    editEntry,
    addCategory,
    removeCategory,
  };
}
