import { useEffect, useState, useCallback } from 'react';
import { useServerStatus } from '../hooks/useServerStatus';
import { X, WifiOff } from 'lucide-react';

function MiniRobotSVG() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="flex-shrink-0"
    >
      <rect x="30" y="45" width="60" height="50" rx="10" className="fill-purple-600/60" />
      <rect x="25" y="15" width="70" height="35" rx="12" className="fill-purple-500/60" />
      <line x1="60" y1="15" x2="60" y2="5" stroke="#a855f7" strokeWidth="3" strokeLinecap="round" />
      <circle cx="60" cy="4" r="4" className="fill-purple-400 animate-pulse" />
      <circle cx="42" cy="30" r="7" className="fill-cyan-400">
        <animate attributeName="opacity" values="1;0.3;1" dur="3s" repeatCount="indefinite" />
      </circle>
      <circle cx="78" cy="30" r="7" className="fill-cyan-400">
        <animate attributeName="opacity" values="1;0.3;1" dur="3s" begin="0.5s" repeatCount="indefinite" />
      </circle>
      <circle cx="44" cy="30" r="3" fill="#1e1b4b" />
      <circle cx="80" cy="30" r="3" fill="#1e1b4b" />
      <rect x="48" y="40" width="24" height="4" rx="2" className="fill-purple-300/60" />
      <rect x="12" y="55" width="18" height="8" rx="4" className="fill-purple-600/40" />
      <rect x="90" y="55" width="18" height="8" rx="4" className="fill-purple-600/40" />
      <rect x="38" y="95" width="14" height="18" rx="4" className="fill-purple-600/40" />
      <rect x="68" y="95" width="14" height="18" rx="4" className="fill-purple-600/40" />
    </svg>
  );
}

function LoadingDots() {
  return (
    <span className="inline-flex gap-1 ml-1">
      <span className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
    </span>
  );
}

interface ServerDownOverlayProps {
  /** Whether this is running inside the Electron desktop app */
  isElectron?: boolean;
  /** Callback to open the server configuration screen */
  onConfigure?: () => void;
  /** Called when user wants to browse local files as a workspace */
  onBrowseFolder?: () => void;
}

const DISMISSED_KEY = 'ai-chat:serverDownDismissed';

function readDismissedState(): boolean {
  try { return localStorage.getItem(DISMISSED_KEY) === 'true'; } catch { return false; }
}

function writeDismissedState(dismissed: boolean): void {
  try { localStorage.setItem(DISMISSED_KEY, String(dismissed)); } catch {}
}

export function ServerDownOverlay({ isElectron, onConfigure, onBrowseFolder }: ServerDownOverlayProps) {
  const { online, lastChecked } = useServerStatus();
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(() => readDismissedState());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!online && lastChecked > 0 && !dismissed) {
      setVisible(true);
    } else if (online) {
      setVisible(false);
      setDismissed(false);
      writeDismissedState(false);
      setElapsed(0);
    }
  }, [online, lastChecked, dismissed]);

  // Track elapsed time
  useEffect(() => {
    if (!visible) return;
    const interval = setInterval(() => setElapsed((p) => p + 1), 1000);
    return () => clearInterval(interval);
  }, [visible]);

  // Auto-collapse after 8 seconds so it doesn't stay in the way
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      setDismissed(true);
      writeDismissedState(true);
    }, 8000);
    return () => clearTimeout(timer);
  }, [visible]);

  // Persist manual dismiss — immediately hide the overlay
  const handleDismiss = useCallback(() => {
    setDismissed(true);
    setVisible(false);
    writeDismissedState(true);
  }, []);

  if (!isElectron) return null;
  if (!visible) return null;

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

  return (
    <div className="fixed top-4 left-4 right-4 z-[9999] flex justify-center pointer-events-none animate-slide-down">
      <div className="pointer-events-auto max-w-xl w-full bg-gray-900 border border-purple-700/40 rounded-2xl shadow-2xl shadow-purple-900/20 backdrop-blur-xl overflow-hidden animate-fade-in">
        {/* Bar */}
        <div className="flex items-center gap-3 px-4 py-3">
          <MiniRobotSVG />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">
                Server is <span className="text-purple-400">Offline</span>
              </span>
              <span className="flex items-center gap-1 px-2 py-0.5 bg-red-900/30 border border-red-800/40 rounded-full">
                <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
                <span className="text-[10px] text-red-400 font-medium">{timeStr}</span>
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              Reconnecting to server <LoadingDots />
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {onBrowseFolder && (
              <button
                onClick={onBrowseFolder}
                className="px-3 py-1.5 bg-amber-600/20 hover:bg-amber-600/30 border border-amber-700/40 text-amber-300 text-xs font-medium rounded-lg transition-all active:scale-95"
              >
                Open Folder
              </button>
            )}
            <button
              onClick={() => { window.location.reload(); }}
              className="px-3 py-1.5 bg-gradient-to-r from-purple-600 to-violet-600 hover:from-purple-500 hover:to-violet-500 text-white text-xs font-medium rounded-lg transition-all active:scale-95"
            >
              Retry
            </button>
            {onConfigure && (
              <button onClick={onConfigure}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-xs font-medium rounded-lg transition-all active:scale-95"
              >
                Server
              </button>
            )}
            <button
              onClick={handleDismiss}
              className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-500 hover:text-gray-300 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>
        {/* Shimmer bottom edge */}
        <div className="h-0.5 bg-gradient-to-r from-transparent via-purple-500/50 to-transparent animate-shimmer" />
      </div>
    </div>
  );
}
