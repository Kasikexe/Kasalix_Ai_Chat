import { useEffect, useState, useCallback } from 'react';
import { Download, X, RefreshCw, CheckCircle, ArrowUpCircle, AlertCircle } from 'lucide-react';

interface UpdateInfo {
  version: string;
  currentVersion: string;
  releaseNotes?: string;
}

type UpdateState =
  | { status: 'idle' }
  | { status: 'available'; info: UpdateInfo }
  | { status: 'downloading'; percent: number }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string };

export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [dismissed, setDismissed] = useState(false);
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

  // Only show when we have a state to display (available, downloading, downloaded, or error)
  if (!isElectron || dismissed || state.status === 'idle') return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[60] animate-slide-down">
      {/* AVAILABLE state */}
      {state.status === 'available' && state.info && (
        <div className="mx-auto max-w-2xl mt-2 px-4">
          <div className="bg-gradient-to-r from-emerald-900/90 to-teal-900/90 backdrop-blur-md border border-emerald-700/50 rounded-xl shadow-2xl shadow-emerald-900/30 p-3 flex items-center gap-3">
            <div className="p-1.5 bg-emerald-500/20 rounded-lg flex-shrink-0">
              <ArrowUpCircle size={20} className="text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-emerald-200">
                Update v{state.info.version} available
              </p>
              <p className="text-[11px] text-emerald-400/70 mt-0.5">
                You're on v{state.info.currentVersion}. Get the latest features.
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleDownload}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-all active:scale-95 flex items-center gap-1.5"
              >
                <Download size={12} />
                Update
              </button>
              <button
                onClick={() => setDismissed(true)}
                className="p-1.5 hover:bg-emerald-800/50 rounded-lg text-emerald-300/50 hover:text-emerald-300 transition-colors"
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
