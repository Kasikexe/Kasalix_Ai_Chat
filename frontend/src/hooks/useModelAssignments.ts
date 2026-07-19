import { useCallback, useEffect, useState } from 'react';
import { api, MODEL_ASSIGNMENT_KEYS, MODEL_ASSIGNMENT_LABELS, MODEL_ASSIGNMENT_ICONS } from '../services/api';
import type { ModelAssignments, OllamaModel } from '../types';

const DEFAULT_ASSIGNMENTS: ModelAssignments = {
  chat_thinking: 'qwen3:4b',
  chat_fast: 'qwen2.5:3b',
  code: 'qwen2.5-coder:7b',
  vision: 'qwen2.5vl:3b',
  extraction: 'qwen2.5:3b',
  editor: 'qwen2.5:3b',
  editor_vision: 'qwen2.5vl:3b',
  search: 'qwen2.5:3b',
};

export type ModelAssignmentKey = keyof ModelAssignments;

export function useModelAssignments() {
  const [assignments, setAssignments] = useState<ModelAssignments>({ ...DEFAULT_ASSIGNMENTS });
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
          return merged;
        });
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

  // Get the model for a given role based on thinking mode
  const getChatModel = useCallback(
    (thinkingEnabled: boolean): string => {
      return thinkingEnabled ? assignments.chat_thinking : assignments.chat_fast;
    },
    [assignments]
  );

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

  return {
    assignments,
    loading,
    saving,
    isAuthed,
    refresh,
    getChatModel,
    updateAssignment,
    saveAll,
  };
}

export { MODEL_ASSIGNMENT_KEYS, MODEL_ASSIGNMENT_LABELS, MODEL_ASSIGNMENT_ICONS, DEFAULT_ASSIGNMENTS };
export type { ModelAssignments };
