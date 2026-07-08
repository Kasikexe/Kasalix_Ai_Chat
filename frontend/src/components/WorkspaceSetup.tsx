import { useState, useEffect, useRef } from 'react';
import { Folder, FolderPlus, Plus, Check, X, Loader, ChevronRight, Home, ArrowUp } from 'lucide-react';
import { api } from '../services/api';
import type { FileEntry } from '../types';

interface Props {
  defaultBasePath: string;
  onSelect: (path: string, name: string) => void;
  onClose?: () => void;
}

export function WorkspaceSetup({ defaultBasePath, onSelect, onClose }: Props) {
  const [basePath, setBasePath] = useState(defaultBasePath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [browsingDirs, setBrowsingDirs] = useState<{ path: string; name: string }[]>([]);
  const newNameRef = useRef<HTMLInputElement>(null);

  const loadDirs = async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getFiles(dirPath);
      setEntries(data.entries.filter((e) => e.type === 'directory'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load projects');
      setEntries([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadDirs(basePath);
  }, [basePath]);

  const handleCreateProject = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const fullPath = basePath.replace(/\\/g, '/').replace(/\/$/, '') + '/' + name;
      // Create the directory by writing a .gitkeep file
      await api.writeFile(fullPath + '/.gitkeep', '');
      onSelect(fullPath, name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create project');
    }
    setCreating(false);
  };

  const handleSelectDir = (entry: FileEntry) => {
    // Navigate into the directory
    setBrowsingDirs((prev) => [...prev, { path: entry.path, name: entry.name }]);
    setBasePath(entry.path);
  };

  const handleGoBack = () => {
    const prev = [...browsingDirs];
    prev.pop();
    setBrowsingDirs(prev);
    if (prev.length > 0) {
      setBasePath(prev[prev.length - 1].path);
    } else {
      setBasePath(defaultBasePath);
    }
  };

  const handleGoHome = () => {
    setBrowsingDirs([]);
    setBasePath(defaultBasePath);
  };

  const handlePickFolder = (entry: FileEntry) => {
    setSelectedName(entry.name);
    const fullPath = entry.path;
    onSelect(fullPath, entry.name);
  };

  const handleCustomSubmit = () => {
    const path = customPath.trim();
    if (!path) return;
    // Extract folder name from path
    const name = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Workspace';
    onSelect(path.replace(/\\/g, '/'), name);
  };

  const dirPathStack = [
    { name: 'Projects', path: defaultBasePath },
    ...browsingDirs,
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center">
              <FolderPlus size={16} className="text-white" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Workspace Setup</h2>
              <p className="text-[10px] text-gray-500">Choose or create a project folder</p>
            </div>
          </div>
          {onClose && (
            <button onClick={onClose} className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-500">
              <X size={16} />
            </button>
          )}
        </div>

        {/* Breadcrumb */}
        <div className="flex items-center gap-1 px-4 py-2 bg-gray-900/80 border-b border-gray-800 overflow-x-auto">
          {dirPathStack.map((d, i) => (
            <span key={i} className="flex items-center gap-1 text-xs whitespace-nowrap">
              {i > 0 && <ChevronRight size={10} className="text-gray-600" />}
              <button
                onClick={() => {
                  const target = dirPathStack.slice(0, i + 1);
                  setBrowsingDirs(target.length > 1 ? target.slice(1) : []);
                  setBasePath(d.path);
                }}
                className={`hover:text-purple-400 transition-colors ${i === dirPathStack.length - 1 ? 'text-purple-400 font-medium' : 'text-gray-500'}`}
              >
                {d.name}
              </button>
            </span>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <span className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-pulse" />
              <span className="ml-2 text-xs text-gray-500">Loading projects...</span>
            </div>
          ) : error ? (
            <div className="text-center py-8 px-4">
              <p className="text-xs text-red-400 mb-2">{error}</p>
              <button
                onClick={() => loadDirs(basePath)}
                className="text-xs text-purple-400 hover:text-purple-300 underline"
              >
                Retry
              </button>
            </div>
          ) : (
            <>
              {/* Breadcrumb navigation */}
              {browsingDirs.length > 0 && (
                <button
                  onClick={handleGoBack}
                  className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-gray-800 rounded-lg text-left transition-colors mb-1"
                >
                  <ArrowUp size={14} className="text-gray-500" />
                  <span className="text-xs text-gray-400">.. (go up)</span>
                </button>
              )}

              {/* Project/directory list */}
              {entries.length === 0 ? (
                <div className="text-center py-8">
                  <Folder size={24} className="mx-auto text-gray-600 mb-2" />
                  <p className="text-xs text-gray-500">No folders found here</p>
                  <p className="text-[10px] text-gray-600 mt-1">Create a new project below</p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {entries.map((entry) => (
                    <div
                      key={entry.path}
                      className="group flex items-center gap-2.5 px-3 py-2.5 hover:bg-gray-800 rounded-lg transition-colors cursor-pointer"
                      onDoubleClick={() => handlePickFolder(entry)}
                    >
                      <button
                        onClick={() => handleSelectDir(entry)}
                        className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
                        title={`Browse ${entry.name}`}
                      >
                        <Folder size={16} className="text-amber-400 flex-shrink-0" />
                        <span className="text-sm text-gray-300 truncate">{entry.name}</span>
                      </button>
                      <button
                        onClick={() => handlePickFolder(entry)}
                        className="opacity-0 group-hover:opacity-100 px-2 py-1 bg-purple-600 hover:bg-purple-700 text-white text-[10px] font-medium rounded transition-all"
                      >
                        Select
                      </button>
                      <button
                        onClick={() => handleSelectDir(entry)}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-700 rounded text-gray-500 transition-all"
                        title="Browse folder"
                      >
                        <ChevronRight size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Bottom actions */}
        <div className="border-t border-gray-800 px-4 py-3 space-y-2">
          {/* New project name input */}
          <div className="flex items-center gap-2">
            <div className="flex-1 relative">
              <Plus size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                ref={newNameRef}
                type="text"
                placeholder="New project name (e.g. my-website)"
                value={newName}
                onChange={(e) => { setNewName(e.target.value); setError(null); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateProject();
                }}
                className="w-full bg-gray-800 text-sm text-gray-200 placeholder-gray-600 rounded-lg pl-8 pr-3 py-2 border border-gray-700 outline-none focus:border-purple-500 transition-colors"
              />
            </div>
            <button
              onClick={handleCreateProject}
              disabled={creating || !newName.trim()}
              className="flex items-center gap-1.5 px-3 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs font-medium rounded-lg transition-colors"
            >
              {creating ? (
                <Loader size={14} className="animate-spin" />
              ) : (
                <>
                  <Plus size={14} />
                  Create
                </>
              )}
            </button>
          </div>

          {/* Custom path toggle */}
          {!showCustom ? (
            <button
              onClick={() => setShowCustom(true)}
              className="text-[11px] text-gray-500 hover:text-purple-400 transition-colors"
            >
              Or type a custom path...
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="C:\\Projects\\my-app"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCustomSubmit(); }}
                className="flex-1 bg-gray-800 text-xs text-gray-200 placeholder-gray-600 rounded-lg px-3 py-2 border border-gray-700 outline-none focus:border-purple-500 transition-colors"
                autoFocus
              />
              <button
                onClick={handleCustomSubmit}
                disabled={!customPath.trim()}
                className="px-3 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
              >
                <Check size={14} />
              </button>
              <button
                onClick={() => setShowCustom(false)}
                className="p-2 hover:bg-gray-800 rounded-lg text-gray-500"
              >
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
