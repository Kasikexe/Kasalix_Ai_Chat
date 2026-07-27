import { useState, useCallback, useEffect, useRef } from 'react';
import { useChat } from '../hooks/useChat';
import { ChatWindow } from './ChatWindow';
import { InputBar } from './InputBar';
import { FileTree } from './FileTree';
import { CodeEditorTabs } from './CodeEditorTabs';
import { TerminalPanel } from './TerminalPanel';
import { DiffView } from './DiffView';
import { ErrorBoundary } from './ErrorBoundary';
import { WorkspaceSetup } from './WorkspaceSetup';
import {
  Wrench, FolderOpen, Plus, ChevronDown, ChevronRight, ChevronLeft,
  FilePlus2, Check, X, Loader, History, FileCode,
  Undo2, Pencil, PanelRightClose, PanelRightOpen,
  Trash2, Play, Lightbulb, ClipboardList,
  MessageSquare, Terminal, GripVertical, Circle, CheckCircle2,
} from 'lucide-react';
import { ServerDownInline } from './ServerDownInline';
import { useServerStatus } from '../hooks/useServerStatus';
import { api } from '../services/api';
import { useToast } from '../hooks/useToast';
import type { Conversation, FileEntry, ModifiedFile, Message } from '../types';

interface OpenFile {
  path: string;
  name: string;
  language: string | null;
  content: string;
  originalContent: string;
  saved: boolean;
  dirty: boolean;
}

interface Props {
  conversation: Conversation | null;
  offlineWorkspace?: string | null;
  onCreateNew: () => void;
  model: string;
  thinkingEnabled?: boolean;
  onMessageSent: () => void;
  onConversationCreated: (id: string) => void;
  onForkConversation?: (messages: Message[]) => void;
}

export function AgentWorkspace({ conversation, offlineWorkspace, onCreateNew, model, thinkingEnabled = false, onMessageSent, onConversationCreated, onForkConversation }: Props) {
  const [workspacePath, setWorkspacePath] = useState(offlineWorkspace || conversation?.workspacePath || '');
  const [loadedPath, setLoadedPath] = useState(offlineWorkspace || conversation?.workspacePath || '');
  const [planningEnabled, setPlanningEnabled] = useState(false);

  const { messages, isStreaming, sendMessage, regenerate, editMessage, deleteMessage, stopGeneration, currentStage, liveDuration } = useChat(
    model,
    conversation?.messages || [],
    conversation?.id,
    thinkingEnabled,
    'agent',
    workspacePath,
    undefined,
    planningEnabled
  );

  // ─── Layout State ──────────────────────────────────────────
  const [showSetup, setShowSetup] = useState(!offlineWorkspace && !conversation?.workspacePath);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [showTerminal, setShowTerminal] = useState(true);
  const [terminalHeight, setTerminalHeight] = useState(180);
  const [leftWidth, setLeftWidth] = useState(224);
  const [rightWidth, setRightWidth] = useState(320);
  const dragRef = useRef<{ type: 'left' | 'right'; startX: number; startSize: number } | null>(null);

  // ─── File Editor State ─────────────────────────────────────
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);

  // ─── Existing State ────────────────────────────────────────
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [pendingCode, setPendingCode] = useState<{ filePath: string; oldContent: string; newContent: string; fileName: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [modifiedFiles, setModifiedFiles] = useState<ModifiedFile[]>([]);
  const [showModified, setShowModified] = useState(false);
  const [revertingFile, setRevertingFile] = useState<string | null>(null);
  const [revertedFiles, setRevertedFiles] = useState<Record<string, boolean>>({});
  const [revertError, setRevertError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [planPending, setPlanPending] = useState(false);
  const approveBtnRef = useRef<HTMLButtonElement>(null);
  const deleteBtnRef = useRef<HTMLButtonElement>(null);
  const wasStreamingRef = useRef(false);
  const planActionTakenRef = useRef(false);

  const { toast } = useToast();
  const { online } = useServerStatus();

  // ─── Chat Handlers ─────────────────────────────────────────
  const handleSend = async (content: string) => {
    const newId = await sendMessage(content);
    if (newId) onConversationCreated(newId);
    onMessageSent();
  };

  const handleRegenerate = async () => {
    const newId = await regenerate();
    if (newId) onConversationCreated(newId);
    onMessageSent();
  };

  const handleEdit = async (index: number, newContent: string) => {
    const newId = await editMessage(index, newContent);
    if (newId) onConversationCreated(newId);
    onMessageSent();
  };

  const handleFork = useCallback((index: number) => {
    const forkMessages = messages.slice(0, index + 1);
    onForkConversation?.(forkMessages);
  }, [messages, onForkConversation]);

  // ─── File Opening / Code Apply ─────────────────────────────
  const openFileInEditor = useCallback(async (file: FileEntry) => {
    // Check if already open
    const existing = openFiles.find((f) => f.path === file.path);
    if (existing) {
      setActiveFilePath(file.path);
      return;
    }

    // Fetch content — in Electron this uses IPC (local FS) so it works offline
    try {
      const result = await api.getFileContent(file.path);
      if (result.content !== null && !result.binary) {
        const newFile: OpenFile = {
          path: file.path,
          name: file.name,
          language: result.language || file.name.split('.').pop() || null,
          content: result.content,
          originalContent: result.content,
          saved: true,
          dirty: false,
        };
        setOpenFiles((prev) => [...prev, newFile]);
        setActiveFilePath(file.path);
        setSelectedFile(file);
      } else if (result.binary) {
        toast('error', 'Cannot edit binary files');
      } else {
        toast('error', 'Could not read file content');
      }
    } catch (e) {
      console.error('Failed to open file:', e);
      // Only show error toast if we're online — offline is expected
      if (online) toast('error', 'Failed to open file');
    }
  }, [openFiles, toast, online]);

  const handleFileContentChange = useCallback((path: string, content: string) => {
    setOpenFiles((prev) => prev.map((f) =>
      f.path === path
        ? { ...f, content, dirty: content !== f.originalContent, saved: false }
        : f
    ));
  }, []);

  const handleFileSave = useCallback((path: string, savedContent: string) => {
    setOpenFiles((prev) => prev.map((f) =>
      f.path === path
        ? { ...f, originalContent: savedContent, saved: true, dirty: false }
        : f
    ));
    // Also track in modified files
    const fileName = path.split('/').pop()?.split('\\').pop() || path;
    setModifiedFiles((prev) => {
      const filtered = prev.filter((f) => f.filePath !== path);
      return [{ filePath: path, fileName, changeType: 'edited', timestamp: Date.now() }, ...filtered];
    });
    onMessageSent();
  }, [onMessageSent]);

  const handleFileClose = useCallback((path: string) => {
    setOpenFiles((prev) => prev.filter((f) => f.path !== path));
  }, []);

  // ─── AI Code Apply Handlers (from chat) ────────────────────
  const handleApplyCode = useCallback(async (filePath: string, codeContent: string) => {
    const workspaceBase = loadedPath.replace(/\\\\/g, '/').replace(/\/$/, '');
    const fullPath = loadedPath && !filePath.startsWith('/') && !filePath.includes(':')
      ? workspaceBase + '/' + filePath
      : filePath;

    const normalizedFull = fullPath.replace(/\\\\/g, '/');
    if (workspaceBase && !normalizedFull.startsWith(workspaceBase)) {
      toast('error', `Cannot write outside workspace: ${filePath}`);
      return;
    }

    let oldContent = '';
    try {
      const result = await api.getFileContent(fullPath);
      if (result.content !== null) oldContent = result.content;
    } catch { /* file doesn't exist */ }

    setPendingCode({
      filePath: fullPath,
      oldContent,
      newContent: codeContent,
      fileName: filePath.split('/').pop()?.split('\\\\').pop() || filePath,
    });
    setApplied(false);
  }, [loadedPath, toast]);

  const handleApproveSave = async () => {
    if (!pendingCode) return;
    setApplying(true);
    try {
      await api.writeFile(pendingCode.filePath, pendingCode.newContent);
      handleFileModified(pendingCode.filePath, pendingCode.oldContent ? 'edited' : 'created', pendingCode.oldContent || undefined);

      // Also open/reload in editor tabs
      const fileName = pendingCode.filePath.split('/').pop()?.split('\\\\').pop() || pendingCode.filePath;
      const lang = fileName.split('.').pop() || null;
      setOpenFiles((prev) => {
        const existing = prev.find((f) => f.path === pendingCode.filePath);
        if (existing) {
          return prev.map((f) =>
            f.path === pendingCode.filePath
              ? { ...f, content: pendingCode.newContent, originalContent: pendingCode.newContent, saved: true, dirty: false }
              : f
          );
        }
        return [...prev, {
          path: pendingCode.filePath,
          name: fileName,
          language: lang,
          content: pendingCode.newContent,
          originalContent: pendingCode.newContent,
          saved: true,
          dirty: false,
        }];
      });

      setApplied(true);
      setTimeout(() => { setPendingCode(null); setApplied(false); }, 2000);
      onMessageSent();
    } catch (e) {
      console.error('Failed to save file:', e);
    }
    setApplying(false);
  };

  const handleReject = useCallback(() => {
    setPendingCode(null);
    setApplied(false);
  }, []);

  const handleApplyAll = useCallback(async (files: { filePath: string; content: string }[]) => {
    let successCount = 0;
    let failCount = 0;
    for (const f of files) {
      try {
        const workspaceBase = loadedPath.replace(/\\\\/g, '/').replace(/\/$/, '');
        const fullPath = loadedPath && !f.filePath.startsWith('/') && !f.filePath.includes(':')
          ? workspaceBase + '/' + f.filePath
          : f.filePath;
        const normalizedFull = fullPath.replace(/\\\\/g, '/');
        if (workspaceBase && !normalizedFull.startsWith(workspaceBase)) { failCount++; continue; }

        let isEdit = false;
        try {
          const result = await api.getFileContent(fullPath);
          if (result.content !== null) isEdit = true;
        } catch { /* new file */ }

        await api.writeFile(fullPath, f.content);

        const fileName = fullPath.split('/').pop()?.split('\\\\').pop() || fullPath;
        setModifiedFiles((prev) => {
          const filtered = prev.filter((mf) => mf.filePath !== fullPath);
          return [{ filePath: fullPath, fileName, changeType: isEdit ? 'edited' : 'created', timestamp: Date.now() }, ...filtered];
        });
        successCount++;
      } catch {
        failCount++;
      }
    }
    if (failCount === 0) {
      toast('success', `Applied ${successCount} file${successCount !== 1 ? 's' : ''}`);
    } else {
      toast('error', `Applied ${successCount}, ${failCount} failed`);
    }
    onMessageSent();
  }, [loadedPath, onMessageSent, toast]);

  const handleFileModified = useCallback((filePath: string, changeType: 'created' | 'edited', originalContent?: string) => {
    const fileName = filePath.split('/').pop()?.split('\\\\').pop() || filePath;
    setModifiedFiles((prev) => {
      const filtered = prev.filter((f) => f.filePath !== filePath);
      return [{ filePath, fileName, changeType, originalContent, timestamp: Date.now() }, ...filtered];
    });
  }, []);

  const handleDeleteFile = useCallback(async (filePath: string) => {
    const workspaceBase = loadedPath.replace(/\\\\/g, '/').replace(/\/$/, '');
    const fullPath = loadedPath && !filePath.startsWith('/') && !filePath.includes(':')
      ? workspaceBase + '/' + filePath
      : filePath;
    const normalizedFull = fullPath.replace(/\\\\/g, '/');
    if (workspaceBase && !normalizedFull.startsWith(workspaceBase)) {
      toast('error', `Cannot delete outside workspace: ${filePath}`);
      return;
    }
    setPendingDelete(fullPath);
  }, [loadedPath, toast]);

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteFile(pendingDelete);
      // Close tab if open
      setOpenFiles((prev) => prev.filter((f) => f.path !== pendingDelete));
      onMessageSent();
      setPendingDelete(null);
    } catch (e) {
      console.error('Failed to delete file:', e);
      toast('error', 'Failed to delete file');
    }
    setDeleting(false);
  };

  const handleRevert = async (mf: ModifiedFile) => {
    setRevertingFile(mf.filePath);
    setRevertError(null);
    try {
      if (mf.changeType === 'created') {
        await api.deleteFile(mf.filePath);
      } else if (mf.originalContent !== undefined) {
        await api.writeFile(mf.filePath, mf.originalContent);
      }
      setRevertedFiles((prev) => ({ ...prev, [mf.filePath]: true }));
      setTimeout(() => {
        setModifiedFiles((prev) => prev.filter((f) => f.filePath !== mf.filePath));
        setRevertedFiles((prev) => { const next = { ...prev }; delete next[mf.filePath]; return next; });
      }, 1500);
    } catch (e) {
      setRevertError(e instanceof Error ? e.message : 'Failed to revert file');
      setTimeout(() => setRevertError(null), 4000);
    }
    setRevertingFile(null);
  };

  const handleWorkspaceSelect = async (path: string, name: string) => {
    setWorkspacePath(path);
    setLoadedPath(path);
    setShowSetup(false);
    if (conversation?.id) {
      try {
        await api.updateConversation(conversation.id, { workspacePath: path });
        onMessageSent();
      } catch (e) { console.error('Failed to save workspace path:', e); }
    }
  };

  // Plan action handlers
  const handleImplementPlan = useCallback(() => {
    planActionTakenRef.current = true;
    setPlanPending(false);
    setPlanningEnabled(false);
    requestAnimationFrame(() => {
      handleSend("Proceed with the implementation following the plan above. Generate the actual code now.");
    });
  }, []);

  const handleEvaluatePlan = useCallback(() => {
    planActionTakenRef.current = true;
    setPlanPending(false);
    requestAnimationFrame(() => {
      handleSend("Please evaluate the plan above and give me your honest opinion on the approach. Is this a good plan?");
    });
  }, []);

  const handleScrapPlan = useCallback(() => {
    planActionTakenRef.current = true;
    setPlanPending(false);
    const lastIdx = messages.length - 1;
    if (lastIdx >= 0 && messages[lastIdx].role === 'assistant') {
      deleteMessage(lastIdx);
    }
  }, [messages, deleteMessage]);

  // When offlineWorkspace changes, set workspace and skip setup
  useEffect(() => {
    if (offlineWorkspace) {
      setWorkspacePath(offlineWorkspace);
      setLoadedPath(offlineWorkspace);
      setShowSetup(false);
    }
  }, [offlineWorkspace]);

  // When active file is closed or removed, switch to the last open file
  useEffect(() => {
    if (activeFilePath && !openFiles.find((f) => f.path === activeFilePath)) {
      setActiveFilePath(openFiles[openFiles.length - 1]?.path ?? null);
    }
  }, [openFiles, activeFilePath]);

  // Auto-focus approve button
  useEffect(() => {
    if (pendingCode && !applied) requestAnimationFrame(() => approveBtnRef.current?.focus());
  }, [pendingCode, applied]);

  // Detect streaming end → plan modal
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      if (planningEnabled && !planActionTakenRef.current) setPlanPending(true);
    }
    wasStreamingRef.current = isStreaming;
    planActionTakenRef.current = false;
  }, [isStreaming, planningEnabled]);

  // ─── Panel Resize Handlers ───────────────────────────────
  const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent, type: 'left' | 'right') => {
    e.preventDefault();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    dragRef.current = {
      type,
      startX: clientX,
      startSize: type === 'left' ? leftWidth : rightWidth,
    };
  }, [leftWidth, rightWidth]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent | TouchEvent) => {
      if (!dragRef.current) return;
      const clientX = 'touches' in e ? (e as TouchEvent).touches[0].clientX : (e as MouseEvent).clientX;
      const delta = clientX - dragRef.current.startX;
      if (dragRef.current.type === 'left') {
        setLeftWidth(Math.max(120, Math.min(400, dragRef.current.startSize + delta)));
      } else {
        setRightWidth(Math.max(240, Math.min(600, dragRef.current.startSize - delta)));
      }
    };
    const handleDragEnd = () => { dragRef.current = null; };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleDragEnd);
    document.addEventListener('touchmove', handleMouseMove, { passive: true });
    document.addEventListener('touchend', handleDragEnd);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleDragEnd);
      document.removeEventListener('touchmove', handleMouseMove);
      document.removeEventListener('touchend', handleDragEnd);
    };
  }, []);

  // ─── Stage → TODO Progress ───────────────────────────────
  const STAGE_TODOS: { key: string; label: string }[] = [
    { key: 'reading:workspace', label: 'Read workspace files' },
    { key: 'search:web', label: 'Search the web' },
    { key: 'search:docs', label: 'Search documentation' },
    { key: 'tool:executing', label: 'Execute tools' },
    { key: 'chat:thinking', label: 'Think through the problem' },
    { key: 'vision:analyzing', label: 'Analyze images' },
    { key: 'planning:create', label: 'Create a plan' },
    { key: 'planning:evaluating', label: 'Evaluate the plan' },
    { key: 'image:generating', label: 'Generate images' },
    { key: 'writing:files', label: 'Write files' },
    { key: 'summary:writing', label: 'Write summary' },
  ];

  const currentTodoIdx = currentStage ? STAGE_TODOS.findIndex((t) => t.key === currentStage) : -1;

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === 'Escape' && isStreaming && !isInput) { e.preventDefault(); stopGeneration(); return; }
      if (e.key === 'Escape' && pendingCode && !applied) { e.preventDefault(); handleReject(); return; }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isStreaming, stopGeneration, pendingCode, applied, handleReject]);

  // Empty state — no conversation selected (skip if we have an offline workspace)
  if (!conversation && !offlineWorkspace) {
    return (
      <ErrorBoundary>
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center max-w-md animate-fade-in">
          <div className="relative mx-auto mb-6">
            <div className="w-20 h-20 mx-auto rounded-2xl bg-gradient-to-br from-purple-500 to-violet-600 flex items-center justify-center shadow-xl shadow-purple-500/20">
              <Wrench size={36} className="text-white" />
            </div>
            <div className="absolute -bottom-1 -right-1 w-7 h-7 bg-emerald-500 rounded-full flex items-center justify-center shadow-lg border-2 border-gray-950">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          </div>
          <h2 className="text-2xl font-semibold text-white mb-2">Agent Mode</h2>
          <p className="text-gray-400 mb-2 max-w-sm mx-auto leading-relaxed">
            The AI can read, write, and run commands in your workspace.
          </p>
          <div className="flex flex-wrap justify-center gap-3 mb-6 text-xs text-gray-500">
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-800/50 border border-gray-700/50">📂 Browse files</span>
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-800/50 border border-gray-700/50">✏️ Edit code</span>
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-800/50 border border-gray-700/50">💻 Run commands</span>
          </div>
          {!online ? (
            <ServerDownInline
              message="Start a session to browse and edit files. The code editor and terminal work offline once a workspace is connected."
              onRetry={() => window.location.reload()}
            />
          ) : (
            <button onClick={onCreateNew}
              className="px-5 py-2.5 bg-gradient-to-r from-purple-600 to-violet-600 hover:from-purple-500 hover:to-violet-500 rounded-xl text-sm font-medium inline-flex items-center gap-2 shadow-lg shadow-purple-600/20 transition-all duration-200 hover:scale-105 active:scale-95"
            >
              <Plus size={16} />
              Start agent session
            </button>
          )}
        </div>
      </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
    {/* Workspace setup dialog */}
    {showSetup && (
      <WorkspaceSetup
        defaultBasePath={undefined}
        onSelect={handleWorkspaceSelect}
        onClose={() => setShowSetup(false)}
      />
    )}

    {/* ─── Main Layout ──────────────────────────────────── */}
    <div className="flex-1 flex overflow-hidden">

      {/* ═══ LEFT PANEL: File Tree ═══ */}
      {leftPanelOpen && workspacePath && (
        <div style={{ width: leftWidth }} className="flex-shrink-0 border-r border-gray-800 bg-gray-900/80 flex flex-col">
          {/* Header */}
          <div className="flex items-center gap-1 px-2 py-2 border-b border-gray-800">
            <FolderOpen size={12} className="text-purple-400 flex-shrink-0" />
            <span className="text-xs text-gray-300 font-medium truncate flex-1">
              {workspacePath.split('/').pop()?.split('\\\\').pop() || 'Workspace'}
            </span>
            <button onClick={() => setShowSetup(true)}
              className="p-0.5 hover:bg-gray-800 rounded text-gray-500 hover:text-gray-300 transition-colors"
            >
              <Pencil size={10} />
            </button>
            <button onClick={() => setLeftPanelOpen(false)}
              className="p-0.5 hover:bg-gray-800 rounded text-gray-500 hover:text-gray-300 transition-colors"
            >
              <ChevronDown size={10} />
            </button>
          </div>

          {/* File tree */}
          <div className="flex-1 overflow-y-auto">
            <FileTree
              rootPath={loadedPath}
              onFileSelect={(file) => openFileInEditor(file)}
              onBrowseFolder={async () => {
                try {
                  const result = await api.openFolderDialog();
                  if (!result.canceled && result.path) {
                    handleWorkspaceSelect(result.path, result.name || 'Workspace');
                  }
                } catch (e) {
                  console.error('Folder dialog failed:', e);
                }
              }}
            />
          </div>

          {/* Modified files */}
          <div className="border-t border-gray-800">
            <button onClick={() => setShowModified(!showModified)}
              className="w-full flex items-center gap-1 px-2 py-1.5 hover:bg-gray-800 transition-colors text-xs text-gray-400"
            >
              {showModified ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              <History size={10} />
              Modified
              {modifiedFiles.length > 0 && (
                <span className="ml-auto text-[10px] text-purple-400">{modifiedFiles.length}</span>
              )}
            </button>
            {showModified && modifiedFiles.length > 0 && (
              <div className="max-h-28 overflow-y-auto">
                {revertError && (
                  <div className="px-2 py-0.5 text-[10px] text-red-400 bg-red-950/30 flex items-center gap-1">
                    <X size={8} />
                    <span>{revertError}</span>
                  </div>
                )}
                {modifiedFiles.map((mf) => {
                  const isReverting = revertingFile === mf.filePath;
                  const isReverted = revertedFiles[mf.filePath];
                  return (
                    <div key={mf.filePath + mf.timestamp}
                      className="flex items-center gap-1 px-2 py-0.5 hover:bg-gray-800 transition-colors group text-[10px]"
                    >
                      <FileCode size={8} className="text-blue-400 flex-shrink-0" />
                      <span className="truncate text-gray-400 flex-1">{mf.fileName}</span>
                      {isReverted ? (
                        <Check size={8} className="text-green-400" />
                      ) : (
                        <button onClick={() => handleRevert(mf)} disabled={isReverting}
                          className="p-0.5 rounded text-gray-600 hover:text-amber-400 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-30"
                        >
                          {isReverting ? <Loader size={8} className="animate-spin" /> : <Undo2 size={8} />}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Left panel toggle button (when closed) */}
      {!leftPanelOpen && workspacePath && (
        <button onClick={() => setLeftPanelOpen(true)}
          className="flex-shrink-0 w-6 flex items-center justify-center border-r border-gray-800 hover:bg-gray-800 transition-colors text-gray-500"
          title="Show file tree"
        >
          <ChevronRight size={12} />
        </button>
      )}

      {/* ═══ LEFT DRAG HANDLE ═══ */}
      {leftPanelOpen && workspacePath && (
        <div
          onMouseDown={(e) => handleDragStart(e, 'left')}
          onTouchStart={(e) => handleDragStart(e, 'left')}
          className="w-1.5 flex-shrink-0 cursor-col-resize hover:bg-purple-500/30 active:bg-purple-500/50 transition-colors group relative"
        >
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-3" />
          <GripVertical size={10} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      )}

      {/* ═══ CENTER: Code Editor + Terminal ═══ */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Workspace path header */}
        {workspacePath && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800 bg-gray-900/50">
            <FolderOpen size={12} className="text-purple-400 flex-shrink-0" />
            <span className="text-xs text-gray-400 truncate flex-1">{workspacePath}</span>

            {/* Toggle buttons */}
            <button onClick={() => setLeftPanelOpen(!leftPanelOpen)}
              className={`p-1 rounded transition-colors ${leftPanelOpen ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
              title={leftPanelOpen ? 'Hide file tree' : 'Show file tree'}
            >
              <FolderOpen size={12} />
            </button>
            <button onClick={() => setShowTerminal(!showTerminal)}
              className={`p-1 rounded transition-colors ${showTerminal ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
              title={showTerminal ? 'Hide terminal' : 'Show terminal'}
            >
              <Terminal size={12} />
            </button>
            <button onClick={() => setRightPanelOpen(!rightPanelOpen)}
              className={`p-1 rounded transition-colors ${rightPanelOpen ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
              title={rightPanelOpen ? 'Hide AI chat' : 'Show AI chat'}
            >
              {rightPanelOpen ? <PanelRightClose size={12} /> : <PanelRightOpen size={12} />}
            </button>
          </div>
        )}

        {/* Code Editor Area */}
        <div className="flex-1 min-h-0 flex flex-col">
          {/* Editor tabs */}
          <div className="flex-1 min-h-0 flex">
            <CodeEditorTabs
              files={openFiles}
              activeFile={activeFilePath}
              onFileSelect={setActiveFilePath}
              onFileClose={handleFileClose}
              onFileContentChange={handleFileContentChange}
              onFileSave={handleFileSave}
            />
          </div>

          {/* Terminal */}
          {showTerminal && (
            <TerminalPanel
              cwd={workspacePath}
              height={terminalHeight}
              onHeightChange={setTerminalHeight}
            />
          )}
        </div>
      </div>

      {/* Right panel toggle button (when closed) */}
      {!rightPanelOpen && (
        <button onClick={() => setRightPanelOpen(true)}
          className="flex-shrink-0 w-6 flex items-center justify-center border-l border-gray-800 hover:bg-gray-800 transition-colors text-gray-500"
          title="Show AI chat"
        >
          <ChevronLeft size={12} />
        </button>
      )}

      {/* ═══ RIGHT DRAG HANDLE ═══ */}
      {rightPanelOpen && (
        <div
          onMouseDown={(e) => handleDragStart(e, 'right')}
          onTouchStart={(e) => handleDragStart(e, 'right')}
          className="w-1.5 flex-shrink-0 cursor-col-resize hover:bg-purple-500/30 active:bg-purple-500/50 transition-colors group relative"
        >
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-3" />
          <GripVertical size={10} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      )}

      {/* ═══ RIGHT PANEL: AI Chat ═══ */}
      {rightPanelOpen && (
        <div style={{ width: rightWidth }} className="flex-shrink-0 border-l border-gray-800 bg-gray-900/80 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
            <div className="flex items-center gap-2">
              <MessageSquare size={14} className="text-purple-400" />
              <span className="text-xs text-gray-300 font-medium">AI Chat</span>
              {isStreaming && (
                <span className="flex items-center gap-1 text-[10px] text-purple-400">
                  <span className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-pulse" />
                  Streaming
                </span>
              )}
            </div>
            <button onClick={() => setRightPanelOpen(false)}
              className="p-1 hover:bg-gray-800 rounded text-gray-500 hover:text-gray-300 transition-colors"
            >
              <X size={14} />
            </button>
          </div>

          {/* TODO Progress Panel — shows when streaming */}
          {isStreaming && currentStage && (
            <div className="border-b border-gray-800 bg-gray-900/60 px-3 py-2">
              <div className="flex items-center gap-1.5 mb-2">
                <ClipboardList size={11} className="text-purple-400" />
                <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">Progress</span>
              </div>
              <div className="space-y-1">
                {STAGE_TODOS.map((todo, idx) => {
                  const isDone = idx < currentTodoIdx;
                  const isCurrent = idx === currentTodoIdx;
                  const isPending = idx > currentTodoIdx;
                  return (
                    <div key={todo.key} className={`flex items-center gap-2 text-[10px] transition-all ${
                      isDone ? 'text-emerald-500' : isCurrent ? 'text-purple-300' : 'text-gray-600'
                    }`}>
                      {isDone ? (
                        <CheckCircle2 size={10} className="text-emerald-500 flex-shrink-0" />
                      ) : isCurrent ? (
                        <Loader size={10} className="animate-spin text-purple-400 flex-shrink-0" />
                      ) : (
                        <Circle size={10} className="text-gray-600 flex-shrink-0" />
                      )}
                      <span className={`truncate ${isCurrent ? 'font-medium' : ''}`}>{todo.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Chat messages */}
          <div className="flex-1 min-h-0">
            {!online && messages.length === 0 ? (
              <ServerDownInline
                compact
                message="AI chat is unavailable while the server is offline. The code editor and terminal still work."
                onRetry={() => window.location.reload()}
              />
            ) : (
            <ChatWindow
              messages={messages}
              isStreaming={isStreaming}
              currentStage={currentStage}
              liveDuration={liveDuration}
              onEdit={handleEdit}
              onDelete={deleteMessage}
              onRegenerate={handleRegenerate}
              onApplyCode={handleApplyCode}
              onDeleteFile={handleDeleteFile}
              onApplyAll={handleApplyAll}
              onFork={handleFork}
            />
            )}
          </div>

          {/* Plan action bar — inline above input */}
          {planPending && (
            <div className="border-t border-violet-800/30 bg-violet-950/20 px-3 py-1.5">
              <div className="flex items-center gap-1.5">
                <ClipboardList size={12} className="text-violet-300" />
                <span className="text-[10px] text-violet-300 flex-1">Plan ready</span>
                <button onClick={handleScrapPlan}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-red-600/10 hover:bg-red-600/20 text-red-400"
                >
                  <Trash2 size={10} />
                </button>
                <button onClick={handleEvaluatePlan}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-amber-600/10 hover:bg-amber-600/20 text-amber-400"
                >
                  <Lightbulb size={10} />
                </button>
                <button onClick={handleImplementPlan}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400"
                >
                  <Play size={10} />
                </button>
              </div>
            </div>
          )}

          {/* Input */}
          <InputBar
            onSend={handleSend}
            onStop={stopGeneration}
            isStreaming={isStreaming}
            planningEnabled={planningEnabled}
            onPlanningToggle={() => setPlanningEnabled(!planningEnabled)}
          />
        </div>
      )}
    </div>

    {/* ═══ MODALS ═══ */}

    {/* Approval modal */}
    {pendingCode && !applied && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
        onClick={(e) => { if (e.target === e.currentTarget) handleReject(); }}
      >
        <div className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl animate-fade-in">
          <div className="flex items-center justify-between p-4 border-b border-gray-800">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-amber-600/20 rounded-xl">
                <FilePlus2 size={20} className="text-amber-400" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-white">Approve File Change</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  <FileCode size={10} className="inline" /> {pendingCode.fileName}
                  <span className="ml-2 text-gray-600">{pendingCode.oldContent ? '✏️ Edit' : '✨ New'}</span>
                </p>
              </div>
            </div>
            <button onClick={handleReject}
              className="p-2 hover:bg-gray-800 rounded-xl text-gray-400 hover:text-gray-200 transition-colors"
            ><X size={18} /></button>
          </div>
          <div className="px-4 py-2 bg-gray-950/30 border-b border-gray-800">
            <code className="text-xs text-gray-400 font-mono break-all select-all">{pendingCode.filePath}</code>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <DiffView oldContent={pendingCode.oldContent} newContent={pendingCode.newContent} filename={pendingCode.fileName} />
          </div>
          <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-800 bg-gray-950/50">
            <button onClick={handleReject}
              className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors border border-gray-700"
            ><X size={16} /> Discard</button>
            <button ref={approveBtnRef} onClick={handleApproveSave} disabled={applying}
              className="flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-emerald-600 to-green-600 hover:from-emerald-500 hover:to-green-500 text-white text-sm font-medium rounded-xl transition-all shadow-lg shadow-emerald-600/20 disabled:opacity-50"
            >
              {applying ? <Loader size={16} className="animate-spin" /> : <Check size={16} />}
              {applying ? 'Saving...' : 'Approve & Save'}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Delete confirmation modal */}
    {pendingDelete && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
        onClick={(e) => { if (e.target === e.currentTarget) setPendingDelete(null); }}
      >
        <div className="w-full max-w-md bg-gray-900 border border-red-800/50 rounded-2xl shadow-2xl animate-fade-in">
          <div className="flex items-center justify-between p-4 border-b border-gray-800">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-red-600/20 rounded-xl"><Trash2 size={20} className="text-red-400" /></div>
              <div><h3 className="text-base font-semibold text-white">Delete File</h3><p className="text-xs text-gray-500 mt-0.5">Cannot be undone</p></div>
            </div>
            <button onClick={() => setPendingDelete(null)}
              className="p-2 hover:bg-gray-800 rounded-xl text-gray-400 hover:text-gray-200 transition-colors"
            ><X size={18} /></button>
          </div>
          <div className="p-4">
            <p className="text-sm text-gray-300 mb-3">Are you sure you want to delete this file?</p>
            <code className="block text-xs text-gray-400 font-mono break-all bg-gray-950/50 p-3 rounded-lg border border-gray-800 select-all">{pendingDelete}</code>
          </div>
          <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-800 bg-gray-950/50">
            <button onClick={() => setPendingDelete(null)}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors border border-gray-700"
            >Cancel</button>
            <button ref={deleteBtnRef} onClick={handleConfirmDelete} disabled={deleting}
              className="flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white text-sm font-medium rounded-xl transition-all shadow-lg shadow-red-600/20 disabled:opacity-50"
            >
              {deleting ? <Loader size={16} className="animate-spin" /> : <Trash2 size={16} />}
              {deleting ? 'Deleting...' : 'Delete File'}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Applied toast */}
    {pendingCode && applied && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
        <div className="w-80 flex flex-col items-center gap-4 p-8 bg-gray-900 border border-emerald-700/50 rounded-2xl shadow-2xl animate-fade-in">
          <div className="w-16 h-16 rounded-full bg-emerald-600/20 flex items-center justify-center">
            <Check size={32} className="text-emerald-400" />
          </div>
          <div className="text-center">
            <h3 className="text-lg font-semibold text-white">File Applied!</h3>
            <p className="text-sm text-gray-400 mt-1">{pendingCode.fileName}</p>
            <p className="text-xs text-gray-600 mt-2">Saved to workspace</p>
          </div>
        </div>
      </div>
    )}
    </ErrorBoundary>
  );
}
