import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Layers, GitBranch, Calendar, X, Loader, Trash2, Sparkles, AlertTriangle, Package, Edit3, Send, Save, Settings2 } from 'lucide-react';
import { api } from '../services/api';
import { BuildProgressModal } from './BuildProgressModal';
import { BuildConfigModal } from './BuildConfigModal';

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

export function ChangelogView({ isAdmin = false }: { isAdmin?: boolean }) {
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [buildResult, setBuildResult] = useState<{ success: boolean; output?: string; error?: string } | null>(null);
  const [buildStage, setBuildStage] = useState('');
  const [buildOutput, setBuildOutput] = useState('');
  const [showConfig, setShowConfig] = useState(false);

  // Draft state
  const [draft, setDraft] = useState('');
  const [draftSavedAt, setDraftSavedAt] = useState<number>(0);
  const [draftLoading, setDraftLoading] = useState(true);
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Publish is now handled via BuildConfigModal — dialog state removed

  const fetchChangelog = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getChangelog();
      setEntries(data.entries || []);
    } catch { setEntries([]); }
    setLoading(false);
  }, []);

  const fetchDraft = useCallback(async () => {
    setDraftLoading(true);
    try {
      const data = await api.getChangelogDraft();
      setDraft(data.draft?.description || '');
      setDraftSavedAt(data.draft?.autoSavedAt || 0);
    } catch { setDraft(''); }
    setDraftLoading(false);
  }, []);

  useEffect(() => {
    fetchChangelog();
    fetchDraft();
  }, [fetchChangelog, fetchDraft]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, []);

  // Auto-save draft with debounce
  const saveDraft = useCallback(async (content: string) => {
    setDraftSaving(true);
    try {
      const data = await api.saveChangelogDraft(content);
      setDraftSavedAt(data.draft?.autoSavedAt || Date.now());
      setDraftDirty(false);
    } catch {}
    setDraftSaving(false);
  }, []);

  const handleDraftChange = (value: string) => {
    setDraft(value);
    setDraftDirty(true);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveDraft(value), 1500);
  };

  // Draft is now published via BuildConfigModal — removed separate publish handler

  const handleDelete = async (version: string) => {
    try {
      await api.deleteChangelogEntry(version);
      await fetchChangelog();
    } catch {}
  };

  // Show config modal instead of building immediately
  const handleBuild = () => {
    setShowConfig(true);
  };

  // Called when user presses "Start Build" in the config modal
  const handleStartBuild = async (buildConfig: {
    version: string;
    productName: string;
    iconPath: string;
    description: string;
    author: string;
    appId: string;
    releaseTitle?: string;
    buildAndroid?: boolean;
  }) => {
    setShowConfig(false);

    // If there's a draft, publish it first (using the config version)
    if (draft.trim()) {
      try {
        const pubTitle = buildConfig.releaseTitle?.trim() || buildConfig.productName;
        await api.publishChangelogDraft(buildConfig.version, pubTitle, 'patch');
        setDraft('');
        setDraftSavedAt(0);
        await fetchChangelog();
      } catch (e) {
        console.error('Failed to publish draft:', e);
      }
    }

    setBuilding(true);
    setBuildStage('');
    setBuildOutput('');
    setBuildResult(null);
    try {
      const result = await api.triggerBuild(
        buildConfig.version,
        {
          onStage: (stage) => setBuildStage(stage),
          onChunk: (chunk) => setBuildOutput((prev) => prev + chunk),
        },
        {
          productName: buildConfig.productName,
          iconPath: buildConfig.iconPath,
          description: buildConfig.description,
          author: buildConfig.author,
          appId: buildConfig.appId,
          buildAndroid: buildConfig.buildAndroid,
        }
      );
      setBuildResult({ success: result.success, output: result.output, error: result.error });
    } catch (e) {
      setBuildResult({ success: false, error: e instanceof Error ? e.message : 'Build request failed' });
    }
    setBuilding(false);
  };

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
        <div className="flex items-center gap-2">
          {isAdmin && entries.length > 0 && (
            <button onClick={handleBuild} disabled={building}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700 border border-gray-700 disabled:opacity-50"
              title="Configure and build Electron app"
            >
              {building ? <Loader size={14} className="animate-spin" /> : <Settings2 size={14} />}
              Build
            </button>
          )}
        </div>
      </div>

      {/* Build config modal (shows before build) */}
      <BuildConfigModal
        isOpen={showConfig}
        onClose={() => setShowConfig(false)}
        onStartBuild={handleStartBuild}
        draftDescription={draft}
      />

      {/* Build progress modal */}
      <BuildProgressModal
        isOpen={building || buildResult !== null}
        isBuilding={building}
        currentStage={buildStage}
        output={buildOutput}
        result={buildResult}
        onClose={() => { setBuilding(false); setBuildResult(null); setBuildStage(''); setBuildOutput(''); }}
      />

      {/* Changelog content */}
      <div className="flex-1 overflow-y-auto">
        {/* ═══════════════ DRAFT SECTION ═══════════════ */}
        {isAdmin && (
          <div className="border-b border-gray-800">
            <div className="max-w-2xl mx-auto p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Edit3 size={14} className="text-purple-400" />
                  <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Working Draft</h3>
                  {draftDirty && (
                    <span className="flex items-center gap-1 text-[9px] text-amber-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                      Unsaved
                    </span>
                  )}
                  {draftSaving && (
                    <span className="flex items-center gap-1 text-[9px] text-gray-500">
                      <Loader size={9} className="animate-spin" />
                      Saving...
                    </span>
                  )}
                  {!draftDirty && !draftSaving && draftSavedAt > 0 && (
                    <span className="flex items-center gap-1 text-[9px] text-gray-600">
                      <Save size={9} />
                      Auto-saved
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {draft.trim() && (
                    <button
                      onClick={() => setShowConfig(true)}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-gradient-to-r from-purple-600 to-violet-600 hover:from-purple-500 hover:to-violet-500 text-white transition-all shadow-lg shadow-purple-600/20 active:scale-95"
                    >
                      <Send size={12} />
                      Publish Release
                    </button>
                  )}
                </div>
              </div>

              {draftLoading ? (
                <div className="flex items-center gap-2 py-8">
                  <Loader size={14} className="animate-spin text-gray-500" />
                  <span className="text-xs text-gray-500">Loading draft...</span>
                </div>
              ) : (
                <>
                  <textarea
                    ref={textareaRef}
                    value={draft}
                    onChange={(e) => handleDraftChange(e.target.value)}
                    placeholder={`Accumulate changes here as you work...\n\nExample:\n- Added new dashboard widget\n- Fixed login timeout bug\n- Improved search performance by 40%\n- Updated dependencies`}
                    rows={6}
                    className="w-full bg-gray-800/80 text-sm text-gray-200 placeholder-gray-600 rounded-xl px-4 py-3 border border-gray-700 outline-none focus:border-purple-700 transition-colors resize-none font-mono text-xs leading-relaxed"
                  />
                  <div className="flex items-center justify-between mt-1.5">
                    <p className="text-[9px] text-gray-600">
                      Changes are auto-saved. Use markdown for formatting.
                    </p>
                    <button
                      onClick={() => saveDraft(draft)}
                      disabled={!draftDirty}
                      className="text-[9px] text-purple-400 hover:text-purple-300 disabled:text-gray-600 transition-colors flex items-center gap-1"
                    >
                      <Save size={10} />
                      Save now
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* ═══════════════ RELEASED VERSIONS ═══════════════ */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader size={20} className="animate-spin text-gray-500" />
          </div>
        ) : entries.length === 0 && !isAdmin ? (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <GitBranch size={40} className="text-gray-700 mb-3" />
            <p className="text-sm text-gray-500">No changelog entries yet</p>
          </div>
        ) : entries.length === 0 ? null : (
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
                            {isAdmin && (
                              <button onClick={() => handleDelete(entry.version)}
                                className="p-1 rounded text-gray-600 hover:text-red-400 hover:bg-red-900/20 opacity-0 group-hover:opacity-100 transition-all"
                              ><Trash2 size={12} /></button>
                            )}
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
