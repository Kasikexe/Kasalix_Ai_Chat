import { Package, Check, X, Loader, Terminal, AlertTriangle } from 'lucide-react';

interface BuildProgressModalProps {
  isOpen: boolean;
  isBuilding: boolean;
  currentStage: string;
  output: string;
  result: { success: boolean; output?: string; error?: string } | null;
  onClose: () => void;
}

const STAGE_LABELS: Record<string, string> = {
  'build:version': 'Updating version...',
  'build:clean': 'Cleaning old builds...',
  'build:vite': 'Building frontend with Vite...',
  'build:electron': 'Packaging Electron app...',
  'build:android': 'Building Android APK...',
};

const STAGE_ORDER = ['build:version', 'build:clean', 'build:vite', 'build:electron', 'build:android'];

export function BuildProgressModal({ isOpen, isBuilding, currentStage, output, result, onClose }: BuildProgressModalProps) {
  if (!isOpen) return null;

  const isDone = result !== null;
  const isSuccess = result?.success;

  // Determine which stage index we're at
  const currentIdx = currentStage ? STAGE_ORDER.indexOf(currentStage) : -1;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget && isDone) onClose(); }}
    >
      <div className={`relative w-full max-w-md bg-gray-900 rounded-2xl border shadow-2xl overflow-hidden transition-all duration-500 ${
        isSuccess ? 'border-emerald-700/50 shadow-emerald-900/20' :
        isDone ? 'border-red-700/50 shadow-red-900/20' :
        'border-gray-700 shadow-purple-900/10'
      }`}>
        {/* Gradient accent bar */}
        <div className={`h-1 w-full transition-all duration-1000 ${
          isSuccess ? 'bg-gradient-to-r from-emerald-500 to-green-500' :
          isDone ? 'bg-gradient-to-r from-red-500 to-rose-500' :
          'bg-gradient-to-r from-purple-500 via-violet-500 to-purple-500 bg-[length:200%_100%] animate-gradient'
        }`} />

        <div className="p-6">
          {/* Icon */}
          <div className="flex justify-center mb-4">
            {isDone ? (
              <div className={`relative w-16 h-16 rounded-full flex items-center justify-center animate-bounce-in ${
                isSuccess ? 'bg-emerald-600/20' : 'bg-red-600/20'
              }`}>
                {isSuccess ? (
                  <div className="absolute inset-0 rounded-full bg-emerald-500/10 animate-ping" />
                ) : null}
                <div className={`relative z-10 ${isSuccess ? 'text-emerald-400' : 'text-red-400'}`}>
                  {isSuccess ? <Check size={32} /> : <X size={32} />}
                </div>
              </div>
            ) : (
              <div className="relative w-16 h-16">
                {/* Spinning outer ring */}
                <div className="absolute inset-0 rounded-full border-2 border-gray-700" />
                <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-purple-500 animate-spin" />
                <div className="absolute inset-2 rounded-full border-2 border-gray-700" />
                <div className="absolute inset-2 rounded-full border-2 border-transparent border-t-violet-400 animate-spin" style={{ animationDuration: '1s' }} />
                {/* Center icon */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <Package size={20} className="text-purple-400" />
                </div>
              </div>
            )}
          </div>

          {/* Title */}
          <h3 className="text-center text-base font-semibold text-white mb-1">
            {isSuccess ? 'Build Complete!' :
             isDone ? 'Build Failed' :
             'Building Electron App'}
          </h3>

          {/* Subtitle */}
          <p className={`text-center text-xs mb-4 transition-all ${
            isDone
              ? isSuccess ? 'text-emerald-400/70' : 'text-red-400/70'
              : 'text-gray-400'
          }`}>
            {isDone
              ? (isSuccess ? 'The installer is ready for download' : 'Check the error details below')
              : currentStage
                ? (STAGE_LABELS[currentStage] || currentStage)
                : 'Starting build...'
            }
          </p>

          {/* Progress bar */}
          <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden mb-4">
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${
                isSuccess ? 'bg-gradient-to-r from-emerald-500 to-green-500' :
                isDone ? 'bg-gradient-to-r from-red-500 to-rose-500' :
                'bg-gradient-to-r from-purple-500 to-violet-500'
              }`}
              style={{ width: isDone ? '100%' : `${Math.min(((currentIdx + 1) / STAGE_ORDER.length) * 100, 95)}%` }}
            />
          </div>

          {/* Build stages — real, driven by SSE events */}
          {!isDone && (
            <div className="space-y-1.5 mb-4">
              {STAGE_ORDER.map((stageKey) => {
                // Hide version stage when no version was provided
                if (stageKey === 'build:version' && currentIdx < 0) return null;
                const idx = STAGE_ORDER.indexOf(stageKey);
                const isCompleted = currentIdx > idx;
                const isCurrent = currentIdx === idx;
                return (
                  <div key={stageKey} className={`flex items-center gap-2 text-[10px] transition-all duration-300 ${
                    isCompleted ? 'text-emerald-400' :
                    isCurrent ? 'text-purple-300' :
                    'text-gray-600'
                  }`}>
                    {isCompleted ? (
                      <Check size={10} className="flex-shrink-0" />
                    ) : isCurrent ? (
                      <Loader size={10} className="animate-spin flex-shrink-0" />
                    ) : (
                      <div className="w-[10px] h-[10px] rounded-full border border-gray-600 flex-shrink-0" />
                    )}
                    <span>{STAGE_LABELS[stageKey] || stageKey}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Real-time output log */}
          {(output || (isDone && (result?.output || result?.error))) && (
            <div className="mb-4 bg-gray-950 rounded-xl border border-gray-800 overflow-hidden">
              <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-gray-800 bg-gray-900/50">
                <Terminal size={10} className="text-gray-500" />
                <span className="text-[9px] text-gray-500 font-medium uppercase tracking-wider">Build Output</span>
                {isBuilding && <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse ml-auto" />}
              </div>
              <pre className="p-3 text-[10px] font-mono text-gray-400 max-h-40 overflow-y-auto whitespace-pre-wrap leading-relaxed">
                {output || (isDone ? (result.output || result.error) : '')}
              </pre>
            </div>
          )}

          {/* Error alert */}
          {isDone && !isSuccess && result?.error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-950/30 border border-red-800/30 mb-4">
              <AlertTriangle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-red-300 leading-relaxed">{result.error}</p>
            </div>
          )}

          {/* Close button */}
          {isDone && (
            <button
              onClick={onClose}
              className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 active:scale-[0.98] ${
                isSuccess
                  ? 'bg-gradient-to-r from-emerald-600 to-green-600 hover:from-emerald-500 hover:to-green-500 text-white shadow-lg shadow-emerald-600/20'
                  : 'bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700'
              }"
            >
              {isSuccess ? <Check size={16} /> : <X size={16} />}
              {isSuccess ? 'Done' : 'Dismiss'}
            </button>
          )}
        </div>

        {/* Loading shimmer overlay (while building) */}
        {!isDone && (
          <div className="absolute inset-0 pointer-events-none bg-gradient-to-t from-transparent via-transparent to-purple-500/5 animate-pulse" />
        )}
      </div>
    </div>
  );
}
