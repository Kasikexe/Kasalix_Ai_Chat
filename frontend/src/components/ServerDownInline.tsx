import { RefreshCw, WifiOff } from 'lucide-react';

function RobotMiniSVG() {
  return (
    <svg
      width="64"
      height="64"
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="drop-shadow-lg"
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

interface Props {
  /** Short contextual message, e.g. \"AI Chat is unavailable\" */
  message?: string;
  /** Optional retry button */
  onRetry?: () => void;
  /** Smaller variant for inline use inside panels */
  compact?: boolean;
}

export function ServerDownInline({ message, onRetry, compact }: Props) {
  return (
    <div className={`flex flex-col items-center justify-center text-center animate-fade-in ${compact ? 'py-8 px-4' : 'py-12 px-6'}`}>
      <div className="relative">
        <RobotMiniSVG />
        <div className="absolute -top-2 -right-2 w-3 h-3 bg-red-500 rounded-full animate-ping" />
      </div>

      <h3 className={`font-semibold text-gray-300 mt-4 ${compact ? 'text-sm' : 'text-base'}`}>
        Server is <span className="text-purple-400">Offline</span>
      </h3>

      <p className={`text-gray-500 mt-1.5 max-w-xs leading-relaxed ${compact ? 'text-xs' : 'text-sm'}`}>
        {message || 'The AI features are unavailable while the backend server is disconnected. The rest of the app still works.'}
      </p>

      <div className="flex items-center gap-2 mt-4">
        <span className="flex items-center gap-1.5 px-2.5 py-1 bg-red-900/30 border border-red-800/40 rounded-full">
          <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
          <span className="text-[10px] text-red-400 font-medium">Disconnected</span>
        </span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="flex items-center gap-1.5 px-3 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-xs text-gray-300 transition-colors"
          >
            <RefreshCw size={12} />
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
