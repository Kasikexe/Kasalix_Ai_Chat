import { useEffect, useState } from 'react';
import { useServerStatus } from '../hooks/useServerStatus';

function RobotSVG() {
  return (
    <svg
      width="120"
      height="120"
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="drop-shadow-2xl"
    >
      {/* Robot body */}
      <rect x="30" y="45" width="60" height="50" rx="10" className="fill-purple-600/80" />
      {/* Head */}
      <rect x="25" y="15" width="70" height="35" rx="12" className="fill-purple-500/80" />
      {/* Antenna */}
      <line x1="60" y1="15" x2="60" y2="5" stroke="#a855f7" strokeWidth="3" strokeLinecap="round" />
      <circle cx="60" cy="4" r="4" className="fill-purple-400 animate-pulse" />
      {/* Eyes */}
      <circle cx="42" cy="30" r="7" className="fill-cyan-400">
        <animate attributeName="opacity" values="1;0.3;1" dur="3s" repeatCount="indefinite" />
      </circle>
      <circle cx="78" cy="30" r="7" className="fill-cyan-400">
        <animate attributeName="opacity" values="1;0.3;1" dur="3s" begin="0.5s" repeatCount="indefinite" />
      </circle>
      {/* Eye pupils */}
      <circle cx="44" cy="30" r="3" fill="#1e1b4b" />
      <circle cx="80" cy="30" r="3" fill="#1e1b4b" />
      {/* Mouth */}
      <rect x="48" y="40" width="24" height="4" rx="2" className="fill-purple-300/60" />
      {/* Arms */}
      <rect x="12" y="55" width="18" height="8" rx="4" className="fill-purple-600/60" />
      <rect x="90" y="55" width="18" height="8" rx="4" className="fill-purple-600/60" />
      {/* Legs */}
      <rect x="38" y="95" width="14" height="18" rx="4" className="fill-purple-600/60" />
      <rect x="68" y="95" width="14" height="18" rx="4" className="fill-purple-600/60" />
      {/* Signal waves */}
      <g transform="translate(60, 8)">
        <path d="M-15,0 Q-15,-12 0,-12 Q15,-12 15,0" fill="none" stroke="#a855f7" strokeWidth="2" strokeLinecap="round" opacity="0.5">
          <animate attributeName="opacity" values="0.5;0;0.5" dur="2s" repeatCount="indefinite" />
        </path>
        <path d="M-20,2 Q-20,-18 0,-18 Q20,-18 20,2" fill="none" stroke="#a855f7" strokeWidth="1.5" strokeLinecap="round" opacity="0.3">
          <animate attributeName="opacity" values="0.3;0;0.3" dur="2s" begin="0.3s" repeatCount="indefinite" />
        </path>
      </g>
    </svg>
  );
}

function LoadingDots() {
  return (
    <span className="inline-flex gap-1 ml-1">
      <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
    </span>
  );
}

interface ServerDownOverlayProps {
  /** Whether this is running inside the Electron desktop app */
  isElectron?: boolean;
  /** Callback to open the server configuration screen */
  onConfigure?: () => void;
}

export function ServerDownOverlay({ isElectron, onConfigure }: ServerDownOverlayProps) {
  const { online, lastChecked } = useServerStatus();
  const [showOverlay, setShowOverlay] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!online && lastChecked > 0) {
      setShowOverlay(true);
    } else if (online) {
      setShowOverlay(false);
      setElapsed(0);
    }
  }, [online, lastChecked]);

  // Track how long the server has been down
  useEffect(() => {
    if (!showOverlay) return;
    const interval = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [showOverlay]);

  // Don't show overlay on web (it has the smaller StatusBanner)
  if (!isElectron) return null;
  if (!showOverlay) return null;

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = minutes > 0
    ? `${minutes}m ${seconds}s`
    : `${seconds}s`;

  return (
    <div className="fixed inset-0 z-[9999] bg-gray-950/95 backdrop-blur-md flex flex-col items-center justify-center animate-fade-in">
      {/* Animated robot */}
      <div className="relative">
        <RobotSVG />
        {/* Floating particles around the robot */}
        <div className="absolute -top-4 -left-4 w-3 h-3 bg-purple-500/20 rounded-full animate-ping" />
        <div className="absolute -bottom-2 -right-3 w-2 h-2 bg-cyan-500/20 rounded-full animate-ping" style={{ animationDelay: '500ms' }} />
      </div>

      {/* Main message */}
      <h1 className="text-3xl font-bold text-white mt-8 tracking-tight">
        Server are <span className="text-purple-400">Down</span>
      </h1>

      {/* Subtitle */}
      <p className="text-gray-400 mt-3 text-sm flex items-center">
        Reconnecting to server
        <LoadingDots />
      </p>

      {/* Time indicator */}
      <div className="mt-6 flex items-center gap-2 px-4 py-2 bg-gray-900/60 border border-gray-800 rounded-full">
        <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
        <span className="text-xs text-gray-500 font-mono">
          Offline for {timeStr}
        </span>
      </div>

      {/* Action buttons */}
      <div className="mt-8 flex gap-3">
        <button
          onClick={() => window.location.reload()}
          className="px-6 py-2.5 bg-gradient-to-r from-purple-600 to-violet-600 hover:from-purple-500 hover:to-violet-500 text-white text-sm font-medium rounded-xl transition-all duration-200 hover:scale-105 active:scale-95 shadow-lg shadow-purple-600/20"
        >
          Retry Connection
        </button>
        {onConfigure && (
          <button
            onClick={onConfigure}
            className="px-6 py-2.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
          >
            Change Server
          </button>
        )}
      </div>

      {/* Decorative background gradient */}
      <div className="absolute inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[400px] h-[400px] bg-purple-600/5 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-[300px] h-[300px] bg-cyan-600/5 rounded-full blur-3xl" />
      </div>
    </div>
  );
}
