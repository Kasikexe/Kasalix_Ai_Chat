import { useEffect, useState } from 'react';
import { X, Puzzle, RefreshCw, AlertCircle, Check, Terminal, Wrench } from 'lucide-react';

interface ToolParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
}

interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  icon: string;
  params: ToolParam[];
}

interface PluginsModalProps {
  open: boolean;
  onClose: () => void;
}

export function PluginsModal({ open, onClose }: PluginsModalProps) {
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTools = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/tools');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTools(data.tools || []);
    } catch (e) {
      setError('Could not load plugins. Is the server running?');
      console.error('[PluginsModal] Failed to fetch tools:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) fetchTools();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl shadow-black/50 overflow-hidden animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/20 rounded-xl">
              <Puzzle size={20} className="text-indigo-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Plugins &amp; Tools</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {tools.length} tool{tools.length !== 1 ? 's' : ''} available
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchTools}
              className="p-2 hover:bg-gray-800 rounded-lg transition-colors text-gray-400 hover:text-gray-200"
              title="Refresh"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-800 rounded-lg transition-colors text-gray-400 hover:text-gray-200"
              title="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 max-h-[60vh] overflow-y-auto">
          {loading && tools.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500">
              <RefreshCw size={32} className="animate-spin mb-3 text-indigo-400/50" />
              <p className="text-sm">Loading plugins...</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500">
              <AlertCircle size={32} className="mb-3 text-red-400/50" />
              <p className="text-sm text-red-400/80">{error}</p>
              <button
                onClick={fetchTools}
                className="mt-3 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs text-gray-300 transition-colors"
              >
                Try again
              </button>
            </div>
          ) : tools.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500">
              <Puzzle size={40} className="mb-3 text-gray-600" />
              <p className="text-sm font-medium text-gray-400">No plugins installed</p>
              <p className="text-xs text-gray-600 mt-1 text-center max-w-xs">
                Plugins extend what the AI can do. New tools will appear here when added.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {tools.map((tool) => (
                <div
                  key={tool.id}
                  className="group bg-gray-800/50 hover:bg-gray-800 border border-gray-700/50 hover:border-gray-700 rounded-xl p-4 transition-all duration-200"
                >
                  <div className="flex items-start gap-3">
                    {/* Icon */}
                    <div className="p-2.5 bg-gradient-to-br from-indigo-500/20 to-purple-500/20 rounded-xl flex-shrink-0 text-xl leading-none">
                      {tool.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      {/* Name & version */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-semibold text-white">{tool.name}</h3>
                        <span className="text-[10px] font-mono text-gray-600 bg-gray-900 px-1.5 py-0.5 rounded">
                          v{tool.version}
                        </span>
                        <span className="text-[10px] font-mono text-indigo-500/60 bg-indigo-500/10 px-1.5 py-0.5 rounded">
                          {tool.id}
                        </span>
                      </div>
                      {/* Description */}
                      <p className="text-xs text-gray-400 mt-1.5 leading-relaxed">
                        {tool.description}
                      </p>
                      {/* Parameters */}
                      {tool.params.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-gray-700/30">
                          <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                            Parameters
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {tool.params.map((param) => (
                              <span
                                key={param.name}
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono ${
                                  param.required
                                    ? 'bg-amber-500/10 text-amber-400/80 border border-amber-500/20'
                                    : 'bg-gray-700/30 text-gray-400 border border-gray-700/30'
                                }`}
                                title={param.description}
                              >
                                {param.required && <Check size={8} className="text-amber-400" />}
                                {param.name}: {param.type}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-between">
          <p className="text-[10px] text-gray-600 flex items-center gap-1">
            <Terminal size={10} />
            Tools run automatically when the AI detects you need them
          </p>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs text-gray-300 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
