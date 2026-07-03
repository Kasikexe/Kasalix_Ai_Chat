import { useState, useEffect, useRef } from 'react';
import { X, Eye, EyeOff, RotateCcw } from 'lucide-react';
import type { OllamaModel } from '../types';
import { formatBytes } from '../utils/format';

interface Props {
  open: boolean;
  onClose: () => void;
  models: OllamaModel[];
  isHidden: (name: string) => boolean;
  onToggle: (name: string) => void;
  onShowAll: () => void;
  onHideAll: (names: string[]) => void;
  onReset?: () => void;
}

export function SettingsModal({
  open, onClose, models, isHidden, onToggle, onShowAll, onHideAll, onReset,
}: Props) {
  const [filter, setFilter] = useState('');
  const modalRef = useRef<HTMLDivElement>(null);

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

  const filtered = models.filter((m) =>
    m.name.toLowerCase().includes(filter.toLowerCase())
  );
  const visibleCount = models.filter((m) => !isHidden(m.name)).length;
  const hiddenCount = models.length - visibleCount;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={modalRef}
        className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl"
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <div>
            <h2 className="text-lg font-semibold text-white">Model Settings</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {visibleCount} visible · {hiddenCount} hidden · shared across devices
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

        <div className="p-4 border-b border-gray-800 space-y-3">
          <input
            type="text"
            placeholder="Filter models..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-gray-600"
          />
          <div className="flex gap-2">
            <button
              onClick={onShowAll}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
            >
              <RotateCcw size={12} /> Show all
            </button>
            <button
              onClick={() => onHideAll(models.map((m) => m.name))}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
            >
              <EyeOff size={12} /> Hide all
            </button>
            {onReset && (
              <button
                onClick={onReset}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors ml-auto"
              >
                <RotateCcw size={12} /> Reset
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="text-center text-gray-500 text-sm py-8">No models match.</p>
          ) : (
            <ul className="space-y-1">
              {filtered.map((m) => {
                const hidden = isHidden(m.name);
                return (
                  <li
                    key={m.name}
                    className={`flex items-center gap-3 p-3 rounded-lg transition-colors ${
                      hidden ? 'bg-gray-800/30 opacity-60' : 'bg-gray-800/50 hover:bg-gray-800'
                    }`}
                  >
                    <button
                      onClick={() => onToggle(m.name)}
                      className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
                        hidden
                          ? 'bg-gray-700 text-gray-500 hover:bg-gray-600'
                          : 'bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30'
                      }`}
                      title={hidden ? 'Show in selector' : 'Hide from selector'}
                    >
                      {hidden ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-medium truncate ${hidden ? 'text-gray-500' : 'text-white'}`}>
                        {m.name}
                      </div>
                      <div className="text-xs text-gray-500 flex gap-2 flex-wrap mt-0.5">
                        {m.size && <span>{formatBytes(m.size)}</span>}
                        {m.details?.parameter_size && <span>• {m.details.parameter_size}</span>}
                        {m.details?.family && <span>• {m.details.family}</span>}
                        {m.details?.quantization_level && <span>• {m.details.quantization_level}</span>}
                      </div>
                    </div>
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded ${
                        hidden ? 'bg-gray-700 text-gray-400' : 'bg-emerald-900/40 text-emerald-400'
                      }`}
                    >
                      {hidden ? 'Hidden' : 'Visible'}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="p-3 border-t border-gray-800 text-xs text-gray-500 text-center">
          Settings apply to all devices on this network · {models.length} models installed
        </div>
      </div>
    </div>
  );
}
