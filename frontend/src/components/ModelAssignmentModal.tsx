import { useState, useEffect } from 'react';
import { X, Check, Save, RotateCcw, Sparkles } from 'lucide-react';
import type { OllamaModel, ModelAssignments } from '../types';
import {
  MODEL_ASSIGNMENT_KEYS,
  MODEL_ASSIGNMENT_LABELS,
  MODEL_ASSIGNMENT_ICONS,
  DEFAULT_ASSIGNMENTS,
} from '../hooks/useModelAssignments';
import type { ModelAssignmentKey } from '../hooks/useModelAssignments';

interface Props {
  open: boolean;
  onClose: () => void;
  models: OllamaModel[];
  assignments: ModelAssignments;
  onSave: (assignments: ModelAssignments) => Promise<boolean>;
}

export function ModelAssignmentModal({ open, onClose, models, assignments, onSave }: Props) {
  const [local, setLocal] = useState<ModelAssignments>({ ...assignments });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (open) {
      setLocal({ ...assignments });
      setSaved(false);
    }
  }, [open, assignments]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (!open) return null;

  const handleSelect = (key: ModelAssignmentKey, modelName: string) => {
    setLocal((prev) => ({ ...prev, [key]: modelName }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    const ok = await onSave(local);
    setSaving(false);
    if (ok) setSaved(true);
  };

  const handleReset = () => {
    setLocal({ ...DEFAULT_ASSIGNMENTS });
    setSaved(false);
  };

  // Suggest best model for each category based on name heuristics
  const suggestForCategory = (key: ModelAssignmentKey): string | null => {
    const name = key;
    if (name === 'vision' || name === 'editor_vision') {
      const vision = models.find((m) =>
        m.name.toLowerCase().includes('vl') || m.name.toLowerCase().includes('vision') || m.name.toLowerCase().includes('llava')
      );
      if (vision) return vision.name;
    }
    if (name === 'code') {
      const coder = models.find((m) =>
        m.name.toLowerCase().includes('coder') || m.name.toLowerCase().includes('deepseek-coder')
      );
      if (coder) return coder.name;
    }
    if (name === 'chat_thinking') {
      const thinking = models.find((m) =>
        m.name.toLowerCase().includes('qwen3') || m.name.toLowerCase().includes('deepseek-r1') || m.name.toLowerCase().includes('qwq')
      );
      if (thinking) return thinking.name;
    }
    if (name === 'extraction' || name === 'editor') {
      const small = [...models]
        .filter((m) => m.details?.parameter_size)
        .sort((a, b) => {
          const extractSize = (s: string) => parseInt(s.replace(/[^0-9]/g, '')) || 999;
          return extractSize(a.details!.parameter_size!) - extractSize(b.details!.parameter_size!);
        });
      if (small.length > 0) return small[0].name;
    }
    return null;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <div>
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <Sparkles size={18} className="text-purple-400" />
              Model Assignments
            </h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Assign which AI model handles each task · {models.length} models installed
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {MODEL_ASSIGNMENT_KEYS.map((key) => {
            const icon = MODEL_ASSIGNMENT_ICONS[key];
            const label = MODEL_ASSIGNMENT_LABELS[key];
            const currentValue = local[key];
            const suggestion = suggestForCategory(key);

            return (
              <div
                key={key}
                className="bg-gray-800/40 border border-gray-700/50 rounded-xl p-4 hover:border-gray-600/50 transition-colors"
              >
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-lg">{icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white">{label}</div>
                    <div className="text-xs text-gray-500 capitalize">{key.replace('_', ' ')}</div>
                  </div>
                  {currentValue && (
                    <span className="text-xs font-mono text-purple-300 bg-purple-900/30 px-2 py-0.5 rounded-full truncate max-w-[180px]">
                      {currentValue}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {models.length === 0 ? (
                    <p className="text-xs text-gray-500 italic">No models installed.</p>
                  ) : (
                    models.map((m) => {
                      const selected = m.name === currentValue;
                      return (
                        <button
                          key={m.name}
                          onClick={() => handleSelect(key, m.name)}
                          className={`text-xs px-2.5 py-1.5 rounded-lg transition-all border ${
                            selected
                              ? 'bg-purple-600/20 border-purple-500/50 text-purple-300 shadow-sm shadow-purple-500/10'
                              : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-200'
                          }`}
                        >
                          {m.name}
                          {m.details?.parameter_size && (
                            <span className="ml-1 opacity-50">{m.details.parameter_size}</span>
                          )}
                        </button>
                      );
                    })
                  )}
                  {suggestion && suggestion !== currentValue && (
                    <button
                      onClick={() => handleSelect(key, suggestion)}
                      className="text-xs px-2.5 py-1.5 rounded-lg border border-dashed border-yellow-600/40 text-yellow-400/70 hover:border-yellow-500/60 hover:text-yellow-300 bg-yellow-900/10 transition-colors"
                      title={`Suggest: ${suggestion}`}
                    >
                      ✨ {suggestion}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-gray-800">
          <button
            onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors text-gray-400"
          >
            <RotateCcw size={12} /> Reset defaults
          </button>

          <div className="flex items-center gap-3">
            {saved && (
              <span className="text-xs text-emerald-400 flex items-center gap-1">
                <Check size={12} /> Saved
              </span>
            )}
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 text-sm bg-purple-600 hover:bg-purple-500 disabled:bg-purple-800 text-white rounded-lg transition-colors"
            >
              <Save size={14} />
              {saving ? 'Saving...' : 'Save Assignments'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
