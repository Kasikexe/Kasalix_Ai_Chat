import { useState, useEffect } from 'react';
import { X, Package, ArrowUp, Loader, Save, FolderOpen, Calendar, User, FileText, Hash, ImageIcon, AlertTriangle, Send } from 'lucide-react';
import { api } from '../services/api';

interface BuildConfig {
  version: string;
  productName: string;
  appId: string;
  iconPath: string;
  description: string;
  author: string;
  lastBuild: number | null;
}

interface BuildConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onStartBuild: (config: {
    version: string;
    productName: string;
    iconPath: string;
    description: string;
    author: string;
    appId: string;
    critical?: boolean;
    releaseTitle?: string;
  }) => void;
  /** Pre-fill the description field with draft changelog content */
  draftDescription?: string;
}

const DEFAULT_CONFIG: BuildConfig = {
  version: '1.0.0',
  productName: 'AI Chat',
  appId: 'com.aichat.desktop',
  iconPath: '',
  description: 'AI Chat Desktop Application',
  author: '',
  lastBuild: null,
};

export function BuildConfigModal({ isOpen, onClose, onStartBuild, draftDescription }: BuildConfigModalProps) {
  const [config, setConfig] = useState<BuildConfig>(DEFAULT_CONFIG);
  const [releaseTitle, setReleaseTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [critical, setCritical] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Load config on open
  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      setReleaseTitle('');
      // Load critical status
      api.getCriticalUpdate()
        .then((data) => setCritical(data.critical))
        .catch(() => setCritical(false));
      api.getBuildConfig()
        .then((data) => {
          const loaded = { ...DEFAULT_CONFIG, ...data.config };
          // If draftDescription is provided (from Publish Release), pre-fill description
          if (draftDescription !== undefined && draftDescription.trim()) {
            loaded.description = draftDescription;
          }
          setConfig(loaded);
        })
        .catch(() => setConfig(DEFAULT_CONFIG))
        .finally(() => setLoading(false));
      setDirty(false);
    }
  }, [isOpen, draftDescription]);

  const update = (partial: Partial<BuildConfig>) => {
    setConfig((prev) => ({ ...prev, ...partial }));
    setDirty(true);
  };

  const bumpVersion = (position: 'major' | 'minor' | 'patch') => {
    const parts = config.version.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (isNaN(parts[i])) parts[i] = 0;
    const idx = position === 'major' ? 0 : position === 'minor' ? 1 : 2;
    for (let i = idx + 1; i < 3; i++) parts[i] = 0;
    parts[idx]++;
    update({ version: `${parts[0]}.${parts[1]}.${parts[2]}` });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const { lastBuild, ...saveData } = config;
      await api.saveBuildConfig(saveData);
      setDirty(false);
    } catch {}
    setSaving(false);
  };

  const handleStartBuild = async () => {
    // Auto-save before building
    try {
      const { lastBuild, ...saveData } = config;
      await api.saveBuildConfig(saveData);
    } catch {}
    // Save critical flag to backend
    try {
      await api.setCriticalUpdate(config.version, critical);
    } catch {}
    onStartBuild({
      version: config.version,
      productName: config.productName,
      iconPath: config.iconPath,
      description: config.description,
      author: config.author,
      appId: config.appId,
      critical,
      releaseTitle: releaseTitle.trim() || undefined,
    });
  };

  const BumpButton = ({ pos, label }: { pos: 'major' | 'minor' | 'patch'; label: string }) => (
    <button
      onClick={() => bumpVersion(pos)}
      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-all bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white border border-gray-700 active:scale-95"
    >
      <ArrowUp size={10} />
      {label}
    </button>
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-lg bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
        {/* Gradient bar */}
        <div className="h-1 bg-gradient-to-r from-purple-500 via-violet-500 to-purple-500 bg-[length:200%_100%] animate-gradient" />

        <div className="p-5">
          {/* Header */}
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-600/20 to-violet-600/20 border border-purple-700/30 flex items-center justify-center">
                <Package size={16} className="text-purple-400" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-white">Build Configuration</h2>
                <p className="text-[10px] text-gray-500">Configure settings before building the installer</p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-200 transition-colors">
              <X size={16} />
            </button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader size={20} className="animate-spin text-gray-500" />
            </div>
          ) : (
            <div className="space-y-4">
              {/* ── Version ──────────────────────────────────── */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="flex items-center gap-1.5 text-[10px] text-gray-500 font-medium uppercase tracking-wider">
                    <Hash size={10} />
                    Version
                  </label>
                  <span className="text-[9px] text-gray-600 font-mono">{config.version}</span>
                </div>
                <div className="flex gap-1.5 mb-2">
                  <BumpButton pos="major" label="Major" />
                  <BumpButton pos="minor" label="Minor" />
                  <BumpButton pos="patch" label="Patch" />
                </div>
                <input
                  type="text" value={config.version}
                  onChange={(e) => update({ version: e.target.value })}
                  placeholder="e.g. 2.4.1"
                  className="w-full bg-gray-800/80 text-sm text-gray-200 placeholder-gray-600 rounded-lg px-3 py-2 border border-gray-700 outline-none focus:border-purple-700 transition-colors font-mono"
                />
              </div>

              {/* ── Release Title ───────────────────────────── */}
              <div>
                <label className="flex items-center gap-1.5 text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5">
                  <Send size={10} />
                  Release Title
                </label>
                <input
                  type="text" value={releaseTitle}
                  onChange={(e) => setReleaseTitle(e.target.value)}
                  placeholder="e.g. Bug Fixes and Performance Improvements"
                  className="w-full bg-gray-800/80 text-sm text-gray-200 placeholder-gray-600 rounded-lg px-3 py-2 border border-gray-700 outline-none focus:border-purple-700 transition-colors"
                />
              </div>

              {/* ── App Name ─────────────────────────────────── */}
              <div>
                <label className="flex items-center gap-1.5 text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5">
                  <Package size={10} />
                  App Name
                </label>
                <input
                  type="text" value={config.productName}
                  onChange={(e) => update({ productName: e.target.value })}
                  placeholder="AI Chat"
                  className="w-full bg-gray-800/80 text-sm text-gray-200 placeholder-gray-600 rounded-lg px-3 py-2 border border-gray-700 outline-none focus:border-purple-700 transition-colors"
                />
              </div>

              {/* ── Description ──────────────────────────────── */}
              <div>
                <label className="flex items-center gap-1.5 text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5">
                  <FileText size={10} />
                  Description
                </label>
                <input
                  type="text" value={config.description}
                  onChange={(e) => update({ description: e.target.value })}
                  placeholder="AI Chat Desktop Application"
                  className="w-full bg-gray-800/80 text-sm text-gray-200 placeholder-gray-600 rounded-lg px-3 py-2 border border-gray-700 outline-none focus:border-purple-700 transition-colors"
                />
              </div>

              {/* ── Author & Icon side by side ──────────────── */}
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="flex items-center gap-1.5 text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5">
                    <User size={10} />
                    Author
                  </label>
                  <input
                    type="text" value={config.author}
                    onChange={(e) => update({ author: e.target.value })}
                    placeholder="Your name"
                    className="w-full bg-gray-800/80 text-sm text-gray-200 placeholder-gray-600 rounded-lg px-3 py-2 border border-gray-700 outline-none focus:border-purple-700 transition-colors"
                  />
                </div>
                <div className="flex-1">
                  <label className="flex items-center gap-1.5 text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5">
                    <FolderOpen size={10} />
                    Icon Path
                  </label>
                  <input
                    type="text" value={config.iconPath}
                    onChange={(e) => update({ iconPath: e.target.value })}
                    placeholder="path/to/icon.ico"
                    className="w-full bg-gray-800/80 text-sm text-gray-200 placeholder-gray-600 rounded-lg px-3 py-2 border border-gray-700 outline-none focus:border-purple-700 transition-colors font-mono text-[11px]"
                  />
                </div>
              </div>

              {/* ── App ID (collapsed) ───────────────────────── */}
              <div>
                <label className="flex items-center gap-1.5 text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5">
                  <ImageIcon size={10} />
                  App ID
                </label>
                <input
                  type="text" value={config.appId}
                  onChange={(e) => update({ appId: e.target.value })}
                  placeholder="com.aichat.desktop"
                  className="w-full bg-gray-800/80 text-sm text-gray-200 placeholder-gray-600 rounded-lg px-3 py-2 border border-gray-700 outline-none focus:border-purple-700 transition-colors font-mono text-[11px]"
                />
              </div>

              {/* ── Critical Update Toggle ─────────────────── */}
              <div className="flex items-center justify-between px-4 py-3 rounded-xl bg-red-900/10 border border-red-800/30">
                <div className="flex items-center gap-3">
                  <div className={`p-1.5 rounded-lg ${critical ? 'bg-red-700/30' : 'bg-gray-700/50'}`}>
                    <AlertTriangle size={16} className={critical ? 'text-red-400' : 'text-gray-500'} />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">
                      {critical ? '🚨 Critical Update' : 'Mark as Critical'}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {critical
                        ? 'Users with auto-update OFF will still be notified'
                        : 'Only users with auto-update ON will see this update'}
                    </p>
                  </div>
                </div>
                <div
                  onClick={() => setCritical(!critical)}
                  className={`relative w-11 h-6 rounded-full cursor-pointer transition-colors duration-200 ${
                    critical ? 'bg-red-600' : 'bg-gray-700'
                  }`}
                >
                  <div
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${
                      critical ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </div>
              </div>

              {/* ── Last Build ─────────────────────────────── */}
              {config.lastBuild && (
                <div className="flex items-center gap-1.5 text-[9px] text-gray-600">
                  <Calendar size={9} />
                  Last build: {new Date(config.lastBuild).toLocaleString()}
                </div>
              )}

              {/* ── Actions ────────────────────────────────── */}
              <div className="flex items-center gap-2 pt-2 border-t border-gray-800">
                {/* Save button */}
                <button
                  onClick={handleSave}
                  disabled={!dirty || saving}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-medium transition-all bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700 border border-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {saving ? <Loader size={12} className="animate-spin" /> : <Save size={12} />}
                  {saving ? 'Saving...' : dirty ? 'Save Settings' : 'Saved'}
                </button>

                <div className="flex-1" />

                {/* Cancel */}
                <button
                  onClick={onClose}
                  className="px-4 py-2 rounded-lg text-[11px] font-medium transition-all bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700 border border-gray-700"
                >
                  Cancel
                </button>

                {/* Start Build */}
                <button
                  onClick={handleStartBuild}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[11px] font-medium transition-all bg-gradient-to-r from-purple-600 to-violet-600 hover:from-purple-500 hover:to-violet-500 text-white shadow-lg shadow-purple-600/20 active:scale-95"
                >
                  <Package size={12} />
                  Start Build
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
