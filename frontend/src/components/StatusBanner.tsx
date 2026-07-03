import { WifiOff } from 'lucide-react';
import type { OllamaModel } from '../types';

interface Props {
  online: boolean;
  models: OllamaModel[];
}

export function StatusBanner({ online, models }: Props) {
  if (online) return null;

  return (
    <div className="bg-red-900/30 border-b border-red-800 px-4 py-2 flex items-center gap-2 text-sm text-red-300">
      <WifiOff size={14} />
      <span className="flex-1">
        Ollama is offline. Models may be unavailable until the server is back.
      </span>
      <span className="text-xs text-red-400/70">
        {models.length} cached model{models.length !== 1 ? 's' : ''}
      </span>
    </div>
  );
}
