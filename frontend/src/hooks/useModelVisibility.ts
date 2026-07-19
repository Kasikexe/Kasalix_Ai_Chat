import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

export function useModelVisibility() {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [isAuthed, setIsAuthed] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [settings, authed] = await Promise.all([
          api.getSettings(),
          api.isAuthenticated(),
        ]);
        setHidden(new Set(settings.hiddenModels));
        setIsAuthed(authed);
      } catch (e) {
        console.error('Failed to load settings:', e);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!loaded || !isAuthed) return;
    api.saveSettings({ hiddenModels: Array.from(hidden) }).catch((e) => {
      console.error('Failed to save settings:', e);
    });
  }, [hidden, loaded, isAuthed]);

  const isHidden = useCallback((name: string) => hidden.has(name), [hidden]);

  const toggle = useCallback((name: string) => {
    if (!isAuthed) return;
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, [isAuthed]);

  const showAll = useCallback(() => {
    if (!isAuthed) return;
    setHidden(new Set());
  }, [isAuthed]);

  const hideAll = useCallback((allNames: string[]) => {
    if (!isAuthed) return;
    setHidden(new Set(allNames));
  }, [isAuthed]);

  const reset = useCallback(async () => {
    if (!isAuthed) return;
    const settings = await api.resetSettings();
    setHidden(new Set(settings.hiddenModels));
  }, [isAuthed]);

  const authenticate = useCallback(async (password: string): Promise<boolean> => {
    const ok = await api.authenticate(password);
    if (ok) setIsAuthed(true);
    return ok;
  }, []);

  return {
    hidden,
    isHidden,
    toggle,
    showAll,
    hideAll,
    reset,
    isAuthed,
    authenticate,
    loaded,
  };
}
