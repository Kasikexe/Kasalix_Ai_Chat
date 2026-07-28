import { useState, useEffect } from 'react';
import { getSavedServerUrl, saveServerUrl, isInCapacitor } from '../services/api';
import { Wifi, Server, Plug, Loader2, CheckCircle, XCircle } from 'lucide-react';

interface ServerConnectProps {
  onConnected: () => void;
}

export function ServerConnect({ onConnected }: ServerConnectProps) {
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('3001');
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [showTip, setShowTip] = useState(false);

  // Check if already configured
  useEffect(() => {
    const saved = getSavedServerUrl();
    if (saved) {
      onConnected();
    }
  }, [onConnected]);

  // If not in Capacitor (desktop browser), auto-skip
  useEffect(() => {
    if (!isInCapacitor() && !getSavedServerUrl()) {
      // Not on mobile and no config needed — skip
      onConnected();
    }
  }, [onConnected]);

  const handleTest = async () => {
    if (!ip.trim()) return;
    
    setTesting(true);
    setStatus('testing');
    setErrorMsg('');
    
    const cleanIp = ip.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const cleanPort = port.trim() || '3001';
    const url = `http://${cleanIp}:${cleanPort}`;
    
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'ok') {
          setStatus('success');
          saveServerUrl(url);
          // Reload the page so the API base URL const gets re-evaluated with the saved URL
          setTimeout(() => window.location.reload(), 800);
          return;
        }
      }
      throw new Error(`Server responded with ${res.status}`);
    } catch (e: any) {
      setStatus('error');
      if (e.name === 'TimeoutError' || e.message?.includes('timeout')) {
        setErrorMsg('Connection timed out. Make sure the PC is on and the backend is running.');
      } else if (e.message?.includes('Failed to fetch') || e.message?.includes('NetworkError')) {
        setErrorMsg('Cannot reach the server. Check:\n• Both devices are on the same WiFi\n• Firewall allows port ' + cleanPort + '\n• The backend is running');
      } else {
        setErrorMsg(e.message || 'Unknown error');
      }
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-gray-950 flex items-center justify-center p-4 z-50">
      <div className="w-full max-w-md">
        {/* Logo / Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-600 to-blue-600 mb-4 shadow-lg shadow-purple-500/20">
            <Wifi className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">Connect to Server</h1>
          <p className="text-sm text-gray-400">
            Enter your PC's IP address to connect
          </p>
        </div>

        {/* Connection Card */}
        <div className="bg-gray-900/80 backdrop-blur-sm rounded-2xl border border-gray-800 p-6 space-y-5">
          {/* IP Input */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              PC IP Address
            </label>
            <div className="relative">
              <Server className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                placeholder="e.g. 192.168.1.50"
                className="w-full bg-gray-800 text-white rounded-xl pl-10 pr-4 py-3 border border-gray-700 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none transition-colors placeholder:text-gray-600"
                onKeyDown={(e) => e.key === 'Enter' && handleTest()}
              />
            </div>
          </div>

          {/* Port Input */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              Port <span className="text-gray-500">(default: 3001)</span>
            </label>
            <input
              type="text"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="3001"
              className="w-full bg-gray-800 text-white rounded-xl px-4 py-3 border border-gray-700 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none transition-colors placeholder:text-gray-600"
              onKeyDown={(e) => e.key === 'Enter' && handleTest()}
            />
          </div>

          {/* Connect Button */}
          <button
            onClick={handleTest}
            disabled={testing || !ip.trim()}
            className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 text-white font-medium rounded-xl py-3 transition-all duration-200 active:scale-[0.98] disabled:active:scale-100"
          >
            {testing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Testing Connection...
              </>
            ) : status === 'success' ? (
              <>
                <CheckCircle className="w-4 h-4" />
                Connected!
              </>
            ) : (
              <>
                <Plug className="w-4 h-4" />
                Connect
              </>
            )}
          </button>

          {/* Status Messages */}
          {status === 'error' && (
            <div className="flex items-start gap-2 p-3 bg-red-900/20 border border-red-800/30 rounded-lg">
              <XCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
              <div className="text-sm text-red-300 whitespace-pre-line">{errorMsg}</div>
            </div>
          )}

          {status === 'success' && (
            <div className="flex items-center gap-2 p-3 bg-green-900/20 border border-green-800/30 rounded-lg">
              <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
              <span className="text-sm text-green-300">Connected successfully! Loading app...</span>
            </div>
          )}
        </div>

        {/* How to find IP tip */}
        <div className="mt-6 text-center">
          <button
            onClick={() => setShowTip(!showTip)}
            className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
          >
            {showTip ? 'Hide instructions' : 'How to find my PC IP?'}
          </button>
          
          {showTip && (
            <div className="mt-3 p-4 bg-gray-900/60 rounded-xl border border-gray-800 text-left space-y-2 text-sm text-gray-400">
              <p><span className="text-gray-300 font-medium">1.</span> On your PC, open Command Prompt</p>
              <p className="text-xs text-gray-500">Press Win+R → type <code className="text-purple-400 bg-gray-800 px-1 rounded">cmd</code> → Enter</p>
              <p><span className="text-gray-300 font-medium">2.</span> Run this command:</p>
              <code className="block text-purple-400 bg-gray-800 px-3 py-1.5 rounded-lg text-xs mt-1">ipconfig</code>
              <p><span className="text-gray-300 font-medium">3.</span> Look for <span className="text-purple-400">IPv4 Address</span> under your active network adapter</p>
              <p className="text-xs text-gray-500">It usually looks like <span className="text-green-400">192.168.x.x</span></p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
