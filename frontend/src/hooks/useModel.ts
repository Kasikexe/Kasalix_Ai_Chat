import { useEffect, useState } from 'react';
import type { OllamaModel } from '../types';
import { api } from '../services/api';
import { useModelVisibility } from './useModelVisibility';
import { useServerStatus } from './useServerStatus';

const STORAGE_KEY = 'ai-chat:selectedModel';

export function useModel() {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [selectedModel, setSelectedModelState] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) || ''
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { isHidden } = useModelVisibility();
  const { online, availableModels, lastChecked } = useServerStatus();

  // Initial fetch
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.getModels();
        if (cancelled) return;
        setModels(list);

        const stored = localStorage.getItem(STORAGE_KEY);
        const isValid = stored && list.some((m) => m.name === stored);
        if (!isValid && list.length > 0) {
          setSelectedModelState(list[0].name);
          localStorage.setItem(STORAGE_KEY, list[0].name);
        }
        if (list.length === 0) {
          setError('No models installed. Run: ollama pull llama3.2');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to connect to Ollama');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Refresh when server status changes
  useEffect(() => {
    if (!lastChecked) return;
    (async () => {
      try {
        const list = await api.getModels();
        setModels(list);
        if (selectedModel && !list.some((m) => m.name === selectedModel)) {
          if (list.length > 0) {
            setSelectedModelState(list[0].name);
            localStorage.setItem(STORAGE_KEY, list[0].name);
          }
        }
        setError(null);
      } catch {
        // server offline
      }
    })();
  }, [lastChecked, selectedModel]);

  // Auto-fallback if selected model becomes hidden
  useEffect(() => {
    if (!selectedModel || loading) return;
    if (isHidden(selectedModel) && models.length > 0) {
      const first = models.find((m) => !isHidden(m.name));
      if (first) {
        setSelectedModelState(first.name);
        localStorage.setItem(STORAGE_KEY, first.name);
      }
    }
  }, [selectedModel, models, isHidden, loading]);

  const setSelectedModel = (model: string) => {
    setSelectedModelState(model);
    localStorage.setItem(STORAGE_KEY, model);
  };

  const getModelStatus = (name: string): 'available' | 'hidden' | 'unavailable' => {
    if (!online || !availableModels.includes(name)) return 'unavailable';
    if (isHidden(name)) return 'hidden';
    return 'available';
  };

  return {
    models,
    allModels: models,
    selectedModel,
    setSelectedModel,
    loading,
    error,
    online,
    getModelStatus,
  };
}
