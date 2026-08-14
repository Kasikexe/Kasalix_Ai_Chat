import { useEffect, useState, useCallback } from 'react';
import { Download, X, RefreshCw, CheckCircle, ArrowUpCircle, AlertCircle, AlertTriangle, ChevronDown } from 'lucide-react';
import { getReleaseForVersion, type ChangelogEntry } from '../services/githubReleases';
import { openExternal } from '../utils/openExternal';
import { RELEASES_URL } from '../config';
import { ReleaseNotesMarkdown } from './ReleaseNotesMarkdown';

interface UpdateInfo {
  version: string;
  currentVersion: string;
  releaseNotes?: string;
  critical?: boolean;
}

type UpdateState =
  | { status: 'idle' }
  | { status: 'available'; info: UpdateInfo }
  | { status: 'downloading'; percent: number }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string };

const AUTO_UPDATE_KEY = 'ai-chat:autoUpdate';

function isAutoUpdateEnabled(): boolean {
  const stored = localStorage.getItem(AUTO_UPDATE_KEY);
  return stored !== 'false'; // default: enabled
}

/** Check if an update info has the critical flag — bypass auto-update setting */
function isCriticalUpdate(info: UpdateInfo | undefined): boolean {
  return info?.critical === true;
}

export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  const [releaseNotes, setReleaseNotes] = useState<ChangelogEntry | null>(null);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI?.isElectron;

  useEffect(() => {
    if (!isElectron) return;
    const api = (window as any).electronAPI;

    // Listen for update events from the main process
    const cleanupAvailable = api.onUpdateAvailable((data: UpdateInfo) => {
      setState({ status: 'available', info: data });
      setDismissed(false);
    });

    const cleanupProgress = api.onUpdateDownloadProgress((data: { percent: number }) => {
      setState((prev) => prev.status === 'downloading' || prev.status === 'available'
        ? { status: 'downloading', percent: data.percent }
        : prev);
    });

    const cleanupDownloaded = api.onUpdateDownloaded((data: { version: string }) => {
      setState({ status: 'downloaded', version: data.version });
    });

    const cleanupError = api.onUpdateError((data: { error: string }) => {
      setState({ status: 'error', message: data.error });
    });

    return () => {
      cleanupAvailable();
      cleanupProgress();
      cleanupDownloaded();
      cleanupError();
    };
  }, [isElectron]);

  // Fetch the GitHub release notes for the available version (falling back to
  // the updater-provided releaseNotes when the GitHub lookup comes up empty).
  const availableVersion = state.status === 'available' ? state.info?.version : undefined;
  const availableReleaseNotes = state.status === 'available' ? state.info?.releaseNotes : undefined;
  useEffect(() => {
    if (!availableVersion) return;
    let cancelled = false;
    setNotesLoading(true);
    setNotesOpen(false);
    getReleaseForVersion(availableVersion).then((entry) => {
      if (cancelled) return;
      if (entry) {
        setReleaseNotes(entry);
      } else if (availableReleaseNotes) {
        // electron-updater feeds releaseNotes as HTML — strip tags so it
        // renders cleanly through the shared Markdown renderer.
        const stripped = String(availableReleaseNotes)
          .replace(/<[^>]*>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .trim();
        setReleaseNotes({
          version: availableVersion,
          title: `v${availableVersion}`,
          description: stripped || '_No release notes provided._',
          date: '',
          type: 'patch',
          prerelease: false,
          url: `${RELEASES_URL}/tag/v${availableVersion}`,
        });
      } else {
        setReleaseNotes(null);
      }
    }).catch(() => {
      if (cancelled) return;
      setReleaseNotes(null);
    }).finally(() => {
      if (!cancelled) setNotesLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [availableVersion, availableReleaseNotes]);

  const handleDownload = useCallback(async () => {
    if (!isElectron) return;
    const api = (window as any).electronAPI;
    setState({ status: 'downloading', percent: 0 });
    await api.downloadUpdate();
  }, [isElectron]);

  const handleInstall = useCallback(async () => {
    if (!isElectron) return;
    const api = (window as any).electronAPI;
    await api.installUpdate();
  }, [isElectron]);

  // Show even when auto-update is disabled IF the update is marked as critical
  const isCritical = state.status === 'available' && isCriticalUpdate(state.info);
  if (!isCritical && (!isAutoUpdateEnabled() || !isElectron || dismissed || state.status === 'idle')) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[60] animate-slide-down">
      {/* AVAILABLE state */}
      {state.status === 'available' && state.info && (
        <div className="mx-auto max-w-2xl mt-2 px-4">
          <div className={`backdrop-blur-md border rounded-xl shadow-2xl p-3 flex items-center gap-3 ${
            isCritical
              ? 'bg-gradient-to-r from-red-900/90 to-rose-900/90 border-red-700/50 shadow-red-900/30'
              : 'bg-gradient-to-r from-emerald-900/90 to-teal-900/90 border-emerald-700/50 shadow-emerald-900/30'
          }`}>
            <div className={`p-1.5 rounded-lg flex-shrink-0 ${isCritical ? 'bg-red-500/20' : 'bg-emerald-500/20'}`}>
              {isCritical ? (
                <AlertTriangle size={20} className="text-red-400" />
              ) : (
                <ArrowUpCircle size={20} className="text-emerald-400" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium ${isCritical ? 'text-red-200' : 'text-emerald-200'}`}>
                {isCritical ? '🚨 Big Update Ready' : `Update v${state.info.version} available`}
              </p>
              <p className={`text-[11px] mt-0.5 ${isCritical ? 'text-red-400/70' : 'text-emerald-400/70'}`}>
                {isCritical
                  ? `Version ${state.info.version} is a critical update.`
                  : `You're on v${state.info.currentVersion}. Get the latest features.`}
              </p>
              {/* Release notes toggle */}
              {(releaseNotes || notesLoading) && (
                <div className="mt-2">
                  <button
                    onClick={() => setNotesOpen(!notesOpen)}
                    aria-expanded={notesOpen}
                    aria-controls="update-banner-release-notes"
                    className={`inline-flex items-center gap-1 text-[11px] font-medium transition-colors ${
                      isCritical ? 'text-red-300/80 hover:text-red-200' : 'text-emerald-300/80 hover:text-emerald-200'
                    }`}
                  >
                    <ChevronDown size={12} className={`transition-transform duration-200 ${notesOpen ? 'rotate-180' : ''}`} />
                    {notesLoading ? 'Loading release notes…' : notesOpen ? 'Hide what\'s new' : 'What\'s new in this version'}
                  </button>
                  {notesOpen && releaseNotes && (
                    <div
                      id="update-banner-release-notes"
                      className={`mt-2 max-h-48 overflow-y-auto rounded-lg border p-3 bg-black/20 ${isCritical ? 'border-red-800/50' : 'border-emerald-800/50'}`}
                    >
                      <p className={`text-[11px] font-semibold mb-1.5 ${isCritical ? 'text-red-100' : 'text-emerald-100'}`}>
                        {releaseNotes.title}
                      </p>
                      <div className={`leading-relaxed ${isCritical ? 'text-red-100/70' : 'text-emerald-100/70'}`}>
                        <ReleaseNotesMarkdown content={releaseNotes.description} accent={isCritical ? 'red' : 'emerald'} />
                      </div>
                      <button
                        onClick={() => openExternal(releaseNotes.url)}
                        className={`mt-2 text-[10px] underline transition-colors ${isCritical ? 'text-red-300/70 hover:text-red-200' : 'text-emerald-300/70 hover:text-emerald-200'}`}
                      >
                        View release on GitHub →
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleDownload}
                className={`px-3 py-1.5 text-white text-xs font-medium rounded-lg transition-all active:scale-95 flex items-center gap-1.5 ${
                  isCritical ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'
                }`}
              >
                <Download size={12} />
                Update
              </button>
              <button
                onClick={() => setDismissed(true)}
                className={`p-1.5 rounded-lg transition-colors ${
                  isCritical ? 'hover:bg-red-800/50 text-red-300/50 hover:text-red-300' : 'hover:bg-emerald-800/50 text-emerald-300/50 hover:text-emerald-300'
                }`}
                title="Dismiss"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DOWNLOADING state */}
      {state.status === 'downloading' && (
        <div className="mx-auto max-w-2xl mt-2 px-4">
          <div className="bg-gradient-to-r from-blue-900/90 to-indigo-900/90 backdrop-blur-md border border-blue-700/50 rounded-xl shadow-2xl p-3 flex items-center gap-3">
            <div className="p-1.5 bg-blue-500/20 rounded-lg flex-shrink-0">
              <RefreshCw size={20} className="text-blue-400 animate-spin" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-blue-200">Downloading update...</p>
              <div className="mt-1.5 h-1.5 bg-blue-900/50 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 rounded-full transition-all duration-300"
                  style={{ width: `${state.percent}%` }}
                />
              </div>
            </div>
            <span className="text-xs text-blue-300/70 font-mono flex-shrink-0">
              {state.percent}%
            </span>
          </div>
        </div>
      )}

      {/* DOWNLOADED state */}
      {state.status === 'downloaded' && (
        <div className="mx-auto max-w-2xl mt-2 px-4">
          <div className="bg-gradient-to-r from-emerald-900/90 to-teal-900/90 backdrop-blur-md border border-emerald-700/50 rounded-xl shadow-2xl p-3 flex items-center gap-3">
            <div className="p-1.5 bg-emerald-500/20 rounded-lg flex-shrink-0">
              <CheckCircle size={20} className="text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-emerald-200">
                v{state.version} ready to install
              </p>
              <p className="text-[11px] text-emerald-400/70 mt-0.5">
                Restart to apply the update.
              </p>
            </div>
            <button
              onClick={handleInstall}
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-all active:scale-95 flex items-center gap-1.5"
            >
              <RefreshCw size={12} />
              Restart
            </button>
          </div>
        </div>
      )}

      {/* ERROR state */}
      {state.status === 'error' && (
        <div className="mx-auto max-w-2xl mt-2 px-4">
          <div className="bg-gradient-to-r from-red-900/90 to-rose-900/90 backdrop-blur-md border border-red-700/50 rounded-xl shadow-2xl p-3 flex items-center gap-3">
            <div className="p-1.5 bg-red-500/20 rounded-lg flex-shrink-0">
              <AlertCircle size={20} className="text-red-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-red-200">Update failed</p>
              <p className="text-[11px] text-red-400/70 mt-0.5 truncate">
                {state.message}
              </p>
            </div>
            <button
              onClick={() => setState({ status: 'idle' })}
              className="px-3 py-1.5 bg-red-600/50 hover:bg-red-600 text-white text-xs font-medium rounded-lg transition-all"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
