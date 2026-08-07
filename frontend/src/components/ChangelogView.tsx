import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Layers, GitBranch, Calendar, Loader, Sparkles, AlertTriangle, ExternalLink, X } from 'lucide-react';
import { openExternal } from '../utils/openExternal';
import { GITHUB_RELEASES_API, RELEASES_URL } from '../config';
// Cache releases briefly so the GitHub API (rate-limited) isn't hit on every open
const CACHE_KEY = 'kasalix:changelog:releases';
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/** A release as returned by the GitHub Releases API */
interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
  html_url: string;
}

interface ChangelogEntry {
  version: string;
  title: string;
  description: string;
  date: string;
  type: 'major' | 'minor' | 'patch';
  prerelease: boolean;
  url: string;
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

/** Guess the change type from a semver-ish tag (v1.2.3 → major/minor/patch). */
function deriveType(tag: string): 'major' | 'minor' | 'patch' {
  const clean = tag.replace(/^v/i, '').split('-')[0];
  const parts = clean.split('.').map(Number);
  if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
    if (parts[1] === 0 && parts[2] === 0) return 'major';
    if (parts[2] === 0) return 'minor';
    return 'patch';
  }
  return 'minor';
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 86400000) return `Today, ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;
  if (diff < 172800000) return `Yesterday, ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Read the cached entries. Returns null when the cache is empty or expired. */
function loadCache(ignoreTTL = false): ChangelogEntry[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.entries)) return null;
    if (!ignoreTTL && Date.now() - (parsed.fetchedAt || 0) > CACHE_TTL) return null;
    return parsed.entries as ChangelogEntry[];
  } catch {
    return null;
  }
}

function saveCache(entries: ChangelogEntry[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), entries }));
  } catch {
    /* storage may be unavailable — ignore */
  }
}

/** Map a GitHub release object to a changelog entry. */
function toEntry(release: GitHubRelease): ChangelogEntry {
  return {
    version: release.tag_name.replace(/^v/i, ''),
    title: release.name || release.tag_name,
    description: release.body?.trim() || '_No description provided._',
    date: release.published_at,
    type: deriveType(release.tag_name),
    prerelease: !!release.prerelease,
    url: release.html_url,
  };
}

interface Props {
  onClose?: () => void;
}

export function ChangelogView({ onClose }: Props) {
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchChangelog = useCallback(async () => {
    setLoading(true);
    setError(null);

    // Serve from cache when it's fresh (even an empty one) — saves a GitHub API call
    const cached = loadCache();
    if (cached) {
      setEntries(cached);
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(GITHUB_RELEASES_API);
      if (!res.ok) {
        // 403/429 = GitHub API rate limit — distinct message, not a connection problem
        if (res.status === 403 || res.status === 429) throw new Error('rate-limited');
        throw new Error(`HTTP ${res.status}`);
      }
      const data: GitHubRelease[] = await res.json();
      if (Array.isArray(data)) {
        const list = data
          .filter((r) => !r.draft)
          .map(toEntry)
          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        setEntries(list);
        saveCache(list);
      }
    } catch (e) {
      const rateLimited = e instanceof Error && e.message === 'rate-limited';
      // Network problem — fall back to a stale cache if it has real content
      const stale = loadCache(true);
      if (stale && stale.length > 0) {
        setEntries(stale);
      } else {
        setError(
          rateLimited
            ? 'GitHub API rate limit reached. Try again in a few minutes.'
            : 'Could not load the changelog. Check your internet connection.'
        );
        setEntries([]);
      }
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
          <span className="text-[10px] text-gray-700 hidden sm:inline">· GitHub Releases</span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-200 transition-colors"
            aria-label="Close changelog"
          >
            <X size={16} />
          </button>
        )}
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
            <button
              onClick={() => openExternal(RELEASES_URL)}
              className="mt-4 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors"
            >
              <ExternalLink size={12} />
              View releases on GitHub
            </button>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <GitBranch size={40} className="text-gray-700 mb-3" />
            <p className="text-sm text-gray-500 mb-1">No releases published yet</p>
            <p className="text-xs text-gray-600 mb-4 max-w-xs">
              Release notes appear here as soon as a release is published on the GitHub repository.
            </p>
            <button
              onClick={() => openExternal(RELEASES_URL)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors"
            >
              <ExternalLink size={12} />
              View releases on GitHub
            </button>
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
                            <button
                              onClick={() => openExternal(entry.url)}
                              className="flex items-center gap-1 hover:underline"
                              title="View on GitHub"
                            >
                              <h3 className={`font-bold font-mono ${isLatest ? 'text-white text-base' : 'text-gray-200 text-sm'}`}>
                                v{entry.version}
                              </h3>
                            </button>
                            {isLatest && (
                              <span className="text-[9px] font-medium text-purple-400 bg-purple-900/20 px-1.5 py-0.5 rounded-full">Latest</span>
                            )}
                            {entry.prerelease && (
                              <span className="text-[9px] font-medium text-amber-400 bg-amber-900/20 px-1.5 py-0.5 rounded-full">Pre-release</span>
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

              {/* Footer link to the full list */}
              <div className="ml-12 mr-4 mt-1 mb-4">
                <button
                  onClick={() => openExternal(RELEASES_URL)}
                  className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-purple-400 transition-colors"
                >
                  <ExternalLink size={12} />
                  View all releases on GitHub
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
