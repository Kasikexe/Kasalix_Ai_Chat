import { useState, useEffect, useCallback } from 'react';
import { Server, Wifi, WifiOff, Loader2, Check, AlertTriangle, Network } from 'lucide-react';

interface DetectedIP {
  address: string;
  netmask: string;
  interface: string;
}

interface ServerConfigProps {
  /** Called after the URL has been saved — triggers a page reload */
  onSaved: () => void;
  /** Can be closed if the user already has a saved config */
  showClose?: boolean;
  onClose?: () => void;
}

export function ServerConfig({ onSaved, showClose, onClose }: ServerConfigProps) {
  const [url, setUrl] = useState('https://localhost:3001');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'idle' | 'success' | 'fail'>('idle');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [detectedIPs, setDetectedIPs] = useState<DetectedIP[]>([]);
  const [scanning, setScanning] = useState(false);

  // Load current URL + detect local IPs on mount
  useEffect(() => {
    (async () => {
      try {
        const result = await (window as any).electronAPI?.getBackendUrl();
        if (result?.url) setUrl(result.url);
      } catch {}
    })();

    // Detect local network IPs for quick-select
    (async () => {
      try {
        setScanning(true);
        const ips = await (window as any).electronAPI?.detectIPs();
        if (Array.isArray(ips) && ips.length > 0) {
          setDetectedIPs(ips);
          // Auto-fill with the first detected IP if no saved config exists
          const result = await (window as any).electronAPI?.getBackendUrl();
          if (!result?.hasSavedConfig && ips.length > 0) {
            setUrl(`https://${ips[0].address}:3001`);
          }
        }
      } catch {}
      setScanning(false);
    })();
  }, []);

  const testConnection = useCallback(async () => {
    setTesting(true);
    setTestResult('idle');
    setError('');
    try {
      // Use the Electron IPC handler (bypasses CORS — uses Node.js http/https directly)
      const result = await (window as any).electronAPI?.testServerUrl(
        `${url.replace(/\/+$/, '')}/api/health`
      );
      if (result?.online) {
        setTestResult('success');
      } else {
        setTestResult('fail');
        setError(result?.error || 'Connection failed — server is not reachable');
      }
    } catch (e: any) {
      setTestResult('fail');
      setError(e?.message || 'Connection failed');
    } finally {
      setTesting(false);
    }
  }, [url]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      // Validate URL format
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        setError('URL must start with http:// or https://');
        setSaving(false);
        return;
      }
      if (!parsed.hostname) {
        setError('Invalid URL — missing hostname');
        setSaving(false);
        return;
      }

      const result = await (window as any).electronAPI?.setBackendUrl(url);
      if (result?.success) {
        onSaved();
      } else {
        setError(result?.error || 'Failed to save');
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to save URL');
    } finally {
      setSaving(false);
    }
  }, [url, onSaved]);

  return (
    <div className="fixed inset-0 z-[9999] bg-gray-950/95 backdrop-blur-md flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="mx-auto w-16 h-16 bg-gradient-to-br from-purple-600 to-violet-600 rounded-2xl flex items-center justify-center shadow-lg shadow-purple-600/20 mb-4">
            <Server size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">Server Configuration</h1>
          <p className="text-gray-400 mt-2 text-sm">
            Enter the URL of the PC running the AI Chat backend server.
          </p>
        </div>

        {/* URL Input */}
        <div className="bg-gray-900/80 border border-gray-800 rounded-xl p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              Backend Server URL
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setTestResult('idle'); setError(''); }}
              placeholder="https://192.168.1.50:3001"
              className="w-full px-4 py-2.5 bg-gray-950 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all font-mono"
            />
          </div>

          {/* Detected IPs — quick-select buttons with full protocol:port */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-2 flex items-center gap-1.5">
              <Network size={12} />
              Local IPs — click to try with port 3001
            </label>
            {scanning ? (
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <Loader2 size={12} className="animate-spin" />
                Scanning network interfaces...
              </div>
            ) : detectedIPs.length > 0 ? (
              <div className="space-y-2">
                {detectedIPs.map((ip) => (
                  <div key={ip.address} className="flex flex-wrap gap-1.5 items-center">
                    <span className="text-[10px] text-gray-600 font-mono w-14 truncate" title={ip.interface}>
                      {ip.interface}:
                    </span>
                    {/* HTTPS variant */}
                    <button
                      onClick={() => { setUrl(`https://${ip.address}:3001`); setTestResult('idle'); setError(''); }}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-mono transition-all duration-200 ${
                        url === `https://${ip.address}:3001`
                          ? 'bg-purple-600/30 border border-purple-500/50 text-purple-300'
                          : 'bg-gray-800/60 border border-gray-700/50 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                      }`}
                    >
                      https://{ip.address}:3001
                    </button>
                    {/* HTTP variant */}
                    <button
                      onClick={() => { setUrl(`http://${ip.address}:3001`); setTestResult('idle'); setError(''); }}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-mono transition-all duration-200 ${
                        url === `http://${ip.address}:3001`
                          ? 'bg-purple-600/30 border border-purple-500/50 text-purple-300'
                          : 'bg-gray-800/60 border border-gray-700/50 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                      }`}
                    >
                      http://{ip.address}:3001
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-600 italic">No network IPs detected</p>
            )}
          </div>

          {/* Connection test result */}
          {testResult === 'success' && (
            <div className="flex items-center gap-2 px-3 py-2 bg-emerald-900/30 border border-emerald-800/50 rounded-lg text-emerald-400 text-sm">
              <Check size={16} />
              Server is reachable
            </div>
          )}
          {testResult === 'fail' && (
            <div className="flex items-center gap-2 px-3 py-2 bg-red-900/30 border border-red-800/50 rounded-lg text-red-400 text-sm">
              <WifiOff size={16} />
              <span className="flex-1">{error || 'Server is not reachable'}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={testConnection}
              disabled={testing || !url}
              className="flex-1 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 rounded-xl text-gray-200 text-sm font-medium transition-all duration-200 flex items-center justify-center gap-2"
            >
              {testing ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Wifi size={16} />
              )}
              Test Connection
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !url}
              className="flex-1 px-4 py-2.5 bg-gradient-to-r from-purple-600 to-violet-600 hover:from-purple-500 hover:to-violet-500 disabled:opacity-50 rounded-xl text-white text-sm font-medium transition-all duration-200 flex items-center justify-center gap-2 shadow-lg shadow-purple-600/20"
            >
              {saving ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Check size={16} />
              )}
              Save &amp; Reload
            </button>
          </div>
        </div>

        {/* Help text */}
        <div className="mt-6 px-4 py-3 bg-gray-900/40 border border-gray-800/50 rounded-xl">
          <div className="flex items-start gap-2 text-gray-500 text-xs">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-gray-400 mb-1">Make sure both PCs are on the same network</p>
              <p>The backend server runs on port <span className="text-gray-300 font-mono">3001</span> with HTTPS. Pick the correct IP from the detected list above, or type it manually.</p>
              {showClose && onClose && (
                <button
                  onClick={onClose}
                  className="mt-3 text-purple-400 hover:text-purple-300 transition-colors"
                >
                  Skip for now
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
