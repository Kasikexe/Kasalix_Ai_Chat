import { useCallback, useEffect, useState } from 'react';
import { api, MODEL_ASSIGNMENT_KEYS, MODEL_ASSIGNMENT_LABELS, MODEL_ASSIGNMENT_ICONS } from '../services/api';
import type { ModelAssignments, OllamaModel } from '../types';

const DEFAULT_ASSIGNMENTS: ModelAssignments = {
  chat: 'qwen3:4b',
  chat_thinking: 'qwen3:4b',
  code: 'qwen2.5-coder:7b',
  vision: 'qwen2.5vl:3b',
  extraction: 'qwen2.5:3b',
  search: 'qwen2.5:3b',
};

export type ModelAssignmentKey = keyof ModelAssignments;

export function useModelAssignments() {
  const [assignments, setAssignments] = useState<ModelAssignments>({ ...DEFAULT_ASSIGNMENTS });
  const [cloudAssignments, setCloudAssignments] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isAuthed, setIsAuthed] = useState(false);

  // Load assignments from backend
  const refresh = useCallback(async () => {
    try {
      const settings = await api.getSettings();
      if (settings.modelAssignments) {
        setAssignments((prev) => {
          const merged = { ...prev };
          for (const key of MODEL_ASSIGNMENT_KEYS) {
            if (settings.modelAssignments![key]) {
              merged[key] = settings.modelAssignments![key];
            }
          }
          // Legacy: older settings stored separate thinking/fast chat models —
          // migrate the old "thinking" choice to the single chat role.
          if (!settings.modelAssignments!.chat) {
            if (settings.modelAssignments!.chat_thinking) {
              merged.chat = settings.modelAssignments!.chat_thinking;
            } else if (settings.modelAssignments!.chat_fast) {
              merged.chat = settings.modelAssignments!.chat_fast;
            }
          }
          return merged;
        });
      }
      if (settings.cloudModelAssignments) {
        setCloudAssignments(settings.cloudModelAssignments);
      }
      const authed = await api.isAuthenticated();
      setIsAuthed(authed);
    } catch (e) {
      console.error('[useModelAssignments] Failed to load:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-fetch assignments when the window regains focus and on a short poll.
  // Model assignments can change OUTSIDE this client (Server GUI → Models
  // page, settings reset) — without this, the running client kept sending
  // the OLD chat model until it was restarted.
  useEffect(() => {
    const onFocus = () => { refresh(); };
    window.addEventListener('focus', onFocus);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 10_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(interval);
    };
  }, [refresh]);

  // Get the base chat model. Thinking mode is toggled on this model itself via
  // the backend think flag when it supports thinking.
  const getChatModel = useCallback((): string => {
    return assignments.chat;
  }, [assignments]);

  // Get the dedicated thinking chat model — used instead of the base chat model
  // while the thinking toggle is ON, but only when the base model can't think.
  const getThinkingModel = useCallback((): string => {
    return assignments.chat_thinking;
  }, [assignments]);

  // Update a single assignment
  const updateAssignment = useCallback(
    async (key: ModelAssignmentKey, modelName: string) => {
      if (!isAuthed) return;
      setSaving(true);
      try {
        const next = { ...assignments, [key]: modelName };
        const result = await api.saveSettings({ modelAssignments: next });
        if (result.modelAssignments) {
          setAssignments((prev) => ({ ...prev, ...result.modelAssignments }));
        } else {
          setAssignments(next);
        }
      } catch (e) {
        console.error('[useModelAssignments] Failed to save:', e);
      } finally {
        setSaving(false);
      }
    },
    [assignments, isAuthed]
  );

  // Save all assignments at once
  const saveAll = useCallback(
    async (next: ModelAssignments) => {
      if (!isAuthed) return false;
      setSaving(true);
      try {
        const result = await api.saveSettings({ modelAssignments: next });
        if (result.modelAssignments) {
          setAssignments((prev) => ({ ...prev, ...result.modelAssignments }));
        } else {
          setAssignments(next);
        }
        return true;
      } catch (e) {
        console.error('[useModelAssignments] Failed to save:', e);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [isAuthed]
  );

  // Get the resolved model for a category — picks cloud if a cloud model is configured
  const getResolvedModel = useCallback(
    (key: ModelAssignmentKey): { model: string; source: 'local' | 'cloud' } => {
      const local = assignments[key];
      const cloud = cloudAssignments[key];
      if (cloud) return { model: cloud, source: 'cloud' };
      return { model: local, source: 'local' };
    },
    [assignments, cloudAssignments]
  );

  return {
    assignments,
    cloudAssignments,
    loading,
    saving,
    isAuthed,
    refresh,
    getChatModel,
    getThinkingModel,
    getResolvedModel,
    updateAssignment,
    saveAll,
  };
}

export { MODEL_ASSIGNMENT_KEYS, MODEL_ASSIGNMENT_LABELS, MODEL_ASSIGNMENT_ICONS, DEFAULT_ASSIGNMENTS };
export type { ModelAssignments };
