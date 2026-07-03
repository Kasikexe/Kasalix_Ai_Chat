import { useEffect, useState } from 'react';
import { Bug, X, RefreshCw } from 'lucide-react';
import { getUserProfile } from '../services/api';

export function DebugOverlay() {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<{ id: string; name: string } | null>(null);
  const [lastResponse, setLastResponse] = useState<string>('');

  const refresh = () => {
    const profile = getUserProfile();
    setInfo(profile);
  };

  useEffect(() => {
    refresh();
    // Refresh every 2 seconds while open
    if (!open) return;
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [open]);

  // Intercept fetch to show last response
  useEffect(() => {
    const origFetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await origFetch(...args);
      if (typeof args[0] === 'string' && args[0].includes('/api/')) {
        const clone = res.clone();
        try {
          const data = await clone.json();
          setLastResponse(JSON.stringify(data).slice(0, 200));
        } catch {
          setLastResponse(`${res.status} ${res.statusText}`);
        }
      }
      return res;
    };
    return () => {
      window.fetch = origFetch;
    };
  }, []);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-50 w-10 h-10 rounded-full bg-gray-800 border border-gray-700 text-gray-400 hover:text-white shadow-lg flex items-center justify-center"
        title="Debug"
      >
        <Bug size={18} />
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] bg-gray-900 border border-gray-700 rounded-lg shadow-2xl text-xs">
      <div className="flex items-center justify-between p-2 border-b border-gray-800">
        <div className="flex items-center gap-2 text-gray-300 font-semibold">
          <Bug size={14} /> Debug Info
        </div>
        <div className="flex gap-1">
          <button
            onClick={refresh}
            className="p-1 hover:bg-gray-800 rounded text-gray-400"
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
          <button
            onClick={() => setOpen(false)}
            className="p-1 hover:bg-gray-800 rounded text-gray-400"
            title="Close"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div className="p-3 space-y-2 font-mono">
        <div>
          <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-1">Browser Profile</div>
          {info ? (
            <>
              <div className="text-emerald-400 break-all">
                <span className="text-gray-500">name:</span> {info.name}
              </div>
              <div className="text-emerald-400 break-all">
                <span className="text-gray-500">id:</span> {info.id}
              </div>
            </>
          ) : (
            <div className="text-red-400">No profile (not logged in)</div>
          )}
        </div>

        <div>
          <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-1">Last API Response</div>
          <div className="text-gray-300 break-all text-[10px] bg-gray-800/50 p-2 rounded">
            {lastResponse || 'No requests yet'}
          </div>
        </div>

        <div className="text-gray-500 text-[10px]">
          📋 Tap an ID to copy
        </div>
      </div>
    </div>
  );
}
