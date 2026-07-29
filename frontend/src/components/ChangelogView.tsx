import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Layers, GitBranch, Calendar, Loader, Sparkles, AlertTriangle } from 'lucide-react';

const GITHUB_CHANGELOG_URL = 'https://raw.githubusercontent.com/Kasikexe/Kasalix/main/changelog.json';

interface ChangelogEntry {
  version: string;
  title: string;
  description: string;
  date: string;
  type: 'major' | 'minor' | 'patch';
}

const TYPE_STYLES: Record<string, { icon: React.ReactNode; label: string; color: string; gradient: string }> = {
  major: {
    icon: <Sparkles size={14} />,
    label: 'Major',
    color: 'text-emerald-400 bg-emerald-900/20 border-emerald-700/30',
    gradient: 'from-emerald-600/10 via-emerald-900/5 to-transparent',
  },
  minor: {
    icon: <Layers size={14} />,
    label: 'Minor',
    color: 'text-blue-400 bg-blue-900/20 border-blue-700/30',
    gradient: 'from-blue-600/10 via-blue-900/5 to-transparent',
  },
  patch: {
    icon: <AlertTriangle size={14} />,
    label: 'Patch',
    color: 'text-amber-400 bg-amber-900/20 border-amber-700/30',
    gradient: 'from-amber-600/10 via-amber-900/5 to-transparent',
  },
};

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 86400000) return `Today, ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;
  if (diff < 172800000) return `Yesterday, ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function ChangelogView() {
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchChangelog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(GITHUB_CHANGELOG_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ChangelogEntry[] = await res.json();
      setEntries(Array.isArray(data) ? data : []);
    } catch (e) {
      setError('Could not load changelog. Check your internet connection.');
      setEntries([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchChangelog();
  }, [fetchChangelog]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-900/50">
        <div className="flex items-center gap-2">
          <GitBranch size={16} className="text-purple-400" />
          <h2 className="text-sm font-medium text-gray-200">Changelog</h2>
          {entries.length > 0 && (
            <span className="text-[10px] text-gray-600 font-mono">v{entries[0]?.version}</span>
          )}
        </div>
      </div>

      {/* Changelog content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader size={20} className="animate-spin text-gray-500" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <GitBranch size={40} className="text-gray-700 mb-3" />
            <p className="text-sm text-gray-500 mb-2">{error}</p>
            <button
              onClick={fetchChangelog}
              className="text-xs text-purple-400 hover:text-purple-300 transition-colors"
            >
              Try again
            </button>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <GitBranch size={40} className="text-gray-700 mb-3" />
            <p className="text-sm text-gray-500">No changelog entries yet</p>
          </div>
        ) : (
          <div className="relative">
            <div className="absolute left-[26px] top-0 bottom-0 w-px bg-gradient-to-b from-purple-500/30 via-gray-700/50 to-gray-800" />
            <div className="py-4 space-y-0">
              {entries.map((entry, idx) => {
                const style = TYPE_STYLES[entry.type] || TYPE_STYLES.patch;
                const isLatest = idx === 0;
                return (
                  <div key={entry.version} className="relative group">
                    <div className={`absolute left-[18px] top-6 w-[17px] h-[17px] rounded-full border-2 z-10 flex items-center justify-center transition-all ${
                      isLatest ? 'border-purple-400 bg-purple-900/50 shadow-[0_0_8px_rgba(168,85,247,0.3)]' : 'border-gray-600 bg-gray-800 group-hover:border-gray-500'
                    }`}>
                      <div className={`w-1.5 h-1.5 rounded-full ${isLatest ? 'bg-purple-400' : 'bg-gray-500'}`} />
                    </div>
                    <div className={`ml-12 mr-4 mb-3 rounded-xl border transition-all ${
                      isLatest
                        ? 'bg-gradient-to-br ' + style.gradient + ' border-purple-700/40 shadow-lg shadow-purple-900/10'
                        : 'bg-gray-900/40 border-gray-800 hover:border-gray-700'
                    }`}>
                      <div className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${style.color}`}>
                              {style.icon}{style.label}
                            </div>
                            <h3 className={`font-bold font-mono ${isLatest ? 'text-white text-base' : 'text-gray-200 text-sm'}`}>
                              v{entry.version}
                            </h3>
                            {isLatest && (
                              <span className="text-[9px] font-medium text-purple-400 bg-purple-900/20 px-1.5 py-0.5 rounded-full">Latest</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span className="flex items-center gap-1 text-[10px] text-gray-500">
                              <Calendar size={10} />
                              {formatDate(entry.date)}
                            </span>
                          </div>
                        </div>
                        <p className={`font-medium mt-2 ${isLatest ? 'text-gray-100 text-sm' : 'text-gray-300 text-sm'}`}>
                          {entry.title}
                        </p>
                        <div className={`mt-2 leading-relaxed ${isLatest ? 'text-gray-300' : 'text-gray-400'}`}>
                          <ReactMarkdown remarkPlugins={[remarkGfm]}
                            components={{
                              ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 text-xs">{children}</ul>,
                              ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 text-xs">{children}</ol>,
                              li: ({ children }) => {
                                const content = String(children);
                                const isChecklist = content.startsWith('[ ]') || content.startsWith('[x]');
                                if (isChecklist) {
                                  const checked = content.startsWith('[x]');
                                  return (
                                    <li className="flex items-start gap-1.5 text-xs">
                                      <span className={`mt-0.5 w-3.5 h-3.5 rounded flex-shrink-0 flex items-center justify-center text-[8px] ${
                                        checked ? 'bg-emerald-600/30 text-emerald-400' : 'bg-gray-700/50 text-gray-500'
                                      }`}>{checked ? '✓' : ''}</span>
                                      <span>{content.slice(3)}</span>
                                    </li>
                                  );
                                }
                                return <li className="text-xs">{children}</li>;
                              },
                              p: ({ children }) => <p className="text-xs mb-1.5 last:mb-0">{children}</p>,
                              strong: ({ children }) => <strong className="text-gray-200 font-semibold">{children}</strong>,
                              code: ({ children }) => <code className="bg-gray-800 px-1 py-0.5 rounded text-[10px] font-mono text-purple-300">{children}</code>,
                              h1: ({ children }) => <h1 className="text-sm font-bold text-gray-200 mt-3 mb-1">{children}</h1>,
                              h2: ({ children }) => <h2 className="text-xs font-bold text-gray-200 mt-2 mb-1">{children}</h2>,
                              h3: ({ children }) => <h3 className="text-[11px] font-bold text-gray-200 mt-2 mb-0.5">{children}</h3>,
                              hr: () => <hr className="border-gray-700 my-2" />,
                            }}
                          >{entry.description}</ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
