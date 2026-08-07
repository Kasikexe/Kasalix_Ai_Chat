import { useState, useEffect } from 'react';
import { X, Info, Scale, FileText, BookOpen, ExternalLink, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

interface LegalDoc {
  name: string;
  path?: string;
  content?: string | null;
}

interface AboutInfo {
  name: string;
  version: string;
  copyright: string;
  license: string;
  legal: LegalDoc[];
}

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Human-readable label for a legal document filename */
function docLabel(name: string): string {
  if (name === 'LICENSE') return 'Apache License 2.0';
  if (name === 'NOTICE') return 'NOTICE (attributions)';
  if (name === 'THIRD_PARTY_NOTICES.md') return 'Third-Party Notices';
  if (name === 'licenses/GPL-3.0.txt') return 'GNU GPL v3 (FFmpeg)';
  return name;
}

export function AboutModal({ open, onClose }: Props) {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [selected, setSelected] = useState<LegalDoc | null>(null);
  const [showList, setShowList] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSelected(null);
    setShowList(false);
    const api = (window as any).electronAPI;
    if (api?.getAboutInfo) {
      api
        .getAboutInfo()
        .then((data: AboutInfo) => {
          setInfo(data);
          // Auto-select the first available document
          const first = data.legal?.find((d) => d.content);
          setSelected(first || null);
        })
        .catch(() => setInfo(null))
        .finally(() => setLoading(false));
    } else {
      // Running in a plain browser — show static fallback info
      setInfo({
        name: 'Kasalix AI Chat',
        version: '',
        copyright: 'Copyright (c) 2026 Filip Kasman',
        license: 'Apache License 2.0',
        legal: [],
      });
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI?.isElectron;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl max-h-[88vh] flex flex-col bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between p-5 pb-3 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-600/20 rounded-xl">
              <Info size={20} className="text-blue-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">About</h2>
              <p className="text-xs text-gray-500 mt-0.5">{info?.name || 'Kasalix AI Chat'}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-800 rounded-xl text-gray-400 hover:text-gray-200 transition-colors"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-gray-500">
              <Loader2 size={20} className="animate-spin mr-2" />
              Loading...
            </div>
          ) : (
            <>
              {/* Identity card */}
              <div className="flex items-center gap-4 p-4 bg-gray-800/30 border border-gray-800 rounded-xl">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center text-white text-2xl font-bold shadow-lg shrink-0">
                  {info?.name?.charAt(0) || 'K'}
                </div>
                <div className="min-w-0">
                  <p className="text-base font-semibold text-white">{info?.name || 'Kasalix AI Chat'}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{info?.copyright || 'Copyright (c) 2026 Filip Kasman'}</p>
                  <div className="flex items-center gap-2 mt-1.5">
                    {info?.version && (
                      <span className="text-xs px-2 py-0.5 bg-blue-900/40 text-blue-300 border border-blue-800 rounded-full">
                        v{info.version}
                      </span>
                    )}
                    <span className="text-xs px-2 py-0.5 bg-emerald-900/40 text-emerald-300 border border-emerald-800 rounded-full flex items-center gap-1">
                      <Scale size={10} />
                      {info?.license || 'Apache License 2.0'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Legal documents */}
              {(info?.legal?.length ?? 0) > 0 ? (
                <div className="space-y-2">
                  <button
                    onClick={() => setShowList(!showList)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-gray-800/30 border border-gray-800 rounded-xl text-sm text-gray-300 hover:bg-gray-800/50 transition-colors"
                  >
                    <span className="flex items-center gap-2">
                      <BookOpen size={15} className="text-purple-400" />
                      Legal documents included with this app
                    </span>
                    {showList ? <ChevronUp size={15} className="text-gray-500" /> : <ChevronDown size={15} className="text-gray-500" />}
                  </button>

                  {showList && (
                    <div className="space-y-1.5 animate-fade-in">
                      {info!.legal.map((doc) => (
                        <div
                          key={doc.name}
                          className={`flex items-center justify-between px-3 py-2 rounded-lg border transition-colors ${
                            selected?.name === doc.name
                              ? 'bg-blue-900/20 border-blue-800/50'
                              : 'bg-gray-800/20 border-gray-800 hover:bg-gray-800/40'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <FileText size={13} className="text-gray-500 shrink-0" />
                            <span className="text-xs text-gray-300 truncate">{docLabel(doc.name)}</span>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {doc.content ? (
                              <button
                                onClick={() => setSelected(doc)}
                                className={`px-2 py-1 text-[11px] rounded-lg transition-colors ${
                                  selected?.name === doc.name
                                    ? 'bg-blue-600 text-white'
                                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                                }`}
                              >
                                View
                              </button>
                            ) : (
                              <span className="text-[10px] text-gray-600 italic">unavailable</span>
                            )}
                            {isElectron && doc.path && (
                              <button
                                onClick={() => (window as any).electronAPI?.openLegalFile(doc.path)}
                                className="p-1.5 bg-gray-700 text-gray-300 hover:bg-gray-600 rounded-lg transition-colors"
                                title="Open in system viewer"
                              >
                                <ExternalLink size={11} />
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Document viewer */}
                  {selected?.content && (
                    <div className="mt-1 bg-gray-950 border border-gray-800 rounded-xl overflow-hidden">
                      <div className="px-3 py-2 border-b border-gray-800 flex items-center justify-between">
                        <span className="text-xs text-gray-400 font-medium">{docLabel(selected.name)}</span>
                        <span className="text-[10px] text-gray-600">
                          {selected.content.length.toLocaleString()} chars
                        </span>
                      </div>
                      <pre className="p-4 text-[11px] leading-relaxed text-gray-300 font-mono whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
                        {selected.content}
                      </pre>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-gray-500 leading-relaxed">
                  Legal documents (LICENSE, NOTICE, THIRD_PARTY_NOTICES) are bundled with the desktop app and
                  available in the project repository.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
