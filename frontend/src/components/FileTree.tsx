import { useState, useCallback, useEffect } from 'react';
import { ChevronRight, ChevronDown, File, Folder, FileCode, FileJson, FileImage, FileText, FileType, Plus, Check, X, FolderOpen, RefreshCw } from 'lucide-react';
import { api } from '../services/api';
import type { FileEntry } from '../types';

interface Props {
  rootPath: string;
  /** Workspace root for the sandbox (defaults to rootPath) */
  workspacePath?: string;
  onFileSelect?: (file: FileEntry) => void;
  /** Called when user wants to browse a local folder as the workspace */
  onBrowseFolder?: () => void;
  /** Changing this value reloads the root listing (e.g. after agent writes) */
  refreshToken?: number;
}

function getFileIcon(name: string, type: 'file' | 'directory') {
  if (type === 'directory') return <Folder size={14} className="text-amber-400" />;

  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
      return <FileCode size={14} className="text-blue-400" />;
    case 'json':
      return <FileJson size={14} className="text-yellow-400" />;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'ico':
      return <FileImage size={14} className="text-green-400" />;
    case 'md':
    case 'txt':
      return <FileText size={14} className="text-gray-400" />;
    case 'css':
    case 'scss':
    case 'less':
    case 'html':
      return <FileType size={14} className="text-orange-400" />;
    default:
      return <File size={14} className="text-gray-500" />;
  }
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function DirectoryNode({ name, path, depth, onFileSelect }: {
  name: string;
  path: string;
  depth: number;
  onFileSelect?: (file: FileEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (children === null) {
      setLoading(true);
      try {
        const data = await api.getFiles(path);
        setChildren(data.entries);
      } catch {
        setChildren([]);
      }
      setLoading(false);
    }
    setExpanded(true);
  }, [expanded, children, path]);

  return (
    <div>
      <button
        onClick={toggle}
        className="w-full flex items-center gap-1.5 px-2 py-1 hover:bg-gray-800 rounded text-xs text-left transition-colors"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        {loading ? (
          <span className="w-3.5 h-3.5 flex items-center justify-center">
            <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-pulse" />
          </span>
        ) : expanded ? (
          <ChevronDown size={12} className="text-gray-500 flex-shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-gray-500 flex-shrink-0" />
        )}
        <Folder size={14} className="text-amber-400 flex-shrink-0" />
        <span className="truncate text-gray-300">{name}</span>
      </button>
      {expanded && children && (
        <div>
          {children.length === 0 ? (
            <div
              className="text-xs text-gray-600 italic px-2 py-1"
              style={{ paddingLeft: `${24 + depth * 16}px` }}
            >
              empty
            </div>
          ) : (
            children.map((child) =>
              child.type === 'directory' ? (
                <DirectoryNode
                  key={child.path}
                  name={child.name}
                  path={child.path}
                  depth={depth + 1}
                  onFileSelect={onFileSelect}
                />
              ) : (
                <button
                  key={child.path}
                  onClick={() => onFileSelect?.(child)}
                  className="w-full flex items-center gap-1.5 px-2 py-1 hover:bg-gray-800 rounded text-xs text-left transition-colors group"
                  style={{ paddingLeft: `${24 + depth * 16}px` }}
                >
                  {getFileIcon(child.name, child.type)}
                  <span className="truncate text-gray-400 group-hover:text-gray-200">{child.name}</span>
                  {child.size !== undefined && (
                    <span className="ml-auto text-[10px] text-gray-600 flex-shrink-0">{formatSize(child.size)}</span>
                  )}
                </button>
              )
            )
          )}
        </div>
      )}
    </div>
  );
}

export function FileTree({ rootPath, workspacePath, onFileSelect, onBrowseFolder, refreshToken }: Props) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [creatingLoading, setCreatingLoading] = useState(false);
  const [creatingError, setCreatingError] = useState<string | null>(null);

  const loadRoot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getFiles(rootPath);
      setEntries(data.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load files');
      setEntries([]);
    }
    setLoading(false);
  }, [rootPath]);

  useEffect(() => {
    if (!entries && !loading && !error) {
      loadRoot();
    }
  }, [entries, loading, error, loadRoot]);

  // External refresh trigger (agent wrote files, etc.)
  useEffect(() => {
    if (refreshToken && refreshToken > 0) {
      loadRoot();
    }
  }, [refreshToken, loadRoot]);

  if (loading && !entries) {
    return (
      <div className="px-3 py-4 text-center">
        <div className="inline-flex items-center gap-2 text-xs text-gray-500">
          <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-pulse" />
          Loading files...
        </div>
      </div>
    );
  }

  if (error) {
    const isE = typeof window !== 'undefined' && !!(window as any).electronAPI?.isElectron;
    return (
      <div className="px-3 py-6 text-center">
        <FolderOpen size={24} className="mx-auto text-gray-600 mb-3" />
        <p className="text-xs text-gray-400 mb-3">Could not load files from this path.</p>
        <div className="flex flex-col gap-2">
          <button
            onClick={loadRoot}
            className="flex items-center justify-center gap-1.5 px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-xs text-gray-300 transition-colors mx-auto"
          >
            <RefreshCw size={12} />
            Retry
          </button>
          {isE && onBrowseFolder && (
            <button
              onClick={onBrowseFolder}
              className="flex items-center justify-center gap-1.5 px-3 py-2 bg-purple-600/20 hover:bg-purple-600/30 border border-purple-700/40 rounded-lg text-xs text-purple-300 transition-colors mx-auto"
            >
              <FolderOpen size={12} />
              Browse Local Folder
            </button>
          )}
        </div>
      </div>
    );
  }
  const handleCreateFile = async () => {
    const name = newFileName.trim();
    if (!name) return;
    setCreatingLoading(true);
    setCreatingError(null);
    try {
      const filePath = rootPath.replace(/\\/g, '/').replace(/\/$/, '') + '/' + name;
      await api.writeFile(filePath, '', workspacePath || rootPath);
      setNewFileName('');
      setCreating(false);
      await loadRoot();
      // Auto-select the new file
      onFileSelect?.({ name, path: filePath, type: 'file', size: 0 });
    } catch (e) {
      setCreatingError(e instanceof Error ? e.message : 'Failed to create file');
    }
    setCreatingLoading(false);
  };

  return (
    <div className="py-1">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-gray-800 mb-1">
        <Folder size={12} className="text-amber-400" />
        <span className="text-xs text-gray-500 font-medium truncate">{rootPath}</span>
        <button
          onClick={() => { setCreating(true); setNewFileName(''); }}
          className="text-[10px] text-gray-600 hover:text-purple-400 transition-colors"
          title="New file"
        >
          <Plus size={12} />
        </button>
        <button
          onClick={loadRoot}
          className="text-[10px] text-gray-600 hover:text-gray-400"
          title="Refresh"
        >
          ↻
        </button>
      </div>

      {creating && (
        <div className="px-3 py-1">
          <div className="flex items-center gap-1">
            <FileCode size={12} className="text-blue-400 flex-shrink-0" />
            <input
              type="text"
              placeholder="filename.ts"
              value={newFileName}
              onChange={(e) => { setNewFileName(e.target.value); setCreatingError(null); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFile();
                if (e.key === 'Escape') { setCreating(false); setNewFileName(''); setCreatingError(null); }
              }}
              className="flex-1 bg-gray-800 text-xs text-gray-200 placeholder-gray-600 rounded px-2 py-1 outline-none border border-gray-700 focus:border-purple-500 transition-colors"
              autoFocus
            />
            <button
              onClick={handleCreateFile}
              disabled={creatingLoading || !newFileName.trim()}
              className="p-1 hover:bg-gray-700 rounded text-green-400 disabled:opacity-30"
            >
              <Check size={12} />
            </button>
            <button
              onClick={() => { setCreating(false); setNewFileName(''); setCreatingError(null); }}
              className="p-1 hover:bg-gray-700 rounded text-gray-500"
            >
              <X size={12} />
            </button>
          </div>
          {creatingError && (
            <p className="text-[10px] text-red-400 mt-1 ml-5">{creatingError}</p>
          )}
        </div>
      )}
      {entries && entries.length === 0 ? (
        <p className="text-xs text-gray-600 text-center py-4">No files found</p>
      ) : (
        entries?.map((entry) =>
          entry.type === 'directory' ? (
            <DirectoryNode
              key={entry.path}
              name={entry.name}
              path={entry.path}
              depth={0}
              onFileSelect={onFileSelect}
            />
          ) : (
            <button
              key={entry.path}
              onClick={() => onFileSelect?.(entry)}
              className="w-full flex items-center gap-1.5 px-2 py-1 hover:bg-gray-800 rounded text-xs text-left transition-colors group"
              style={{ paddingLeft: '24px' }}
            >
              {getFileIcon(entry.name, entry.type)}
              <span className="truncate text-gray-400 group-hover:text-gray-200">{entry.name}</span>
              {entry.size !== undefined && (
                <span className="ml-auto text-[10px] text-gray-600 flex-shrink-0">{formatSize(entry.size)}</span>
              )}
            </button>
          )
        )
      )}
    </div>
  );
}
