import { useState, useCallback, useEffect, useRef } from 'react';
import { useChat } from '../hooks/useChat';
import { ChatWindow } from './ChatWindow';
import { InputBar } from './InputBar';
import { FileTree } from './FileTree';
import { FilePreview } from './FilePreview';
import { DiffView } from './DiffView';
import { ErrorBoundary } from './ErrorBoundary';
import { WorkspaceSetup } from './WorkspaceSetup';
import { Wrench, FolderOpen, Plus, FolderTree, ChevronDown, ChevronRight, FilePlus2, Check, X, Loader, History, FileCode, Undo2, Pencil, PanelRightClose, PanelRightOpen, Trash2, Play, Lightbulb, ClipboardList } from 'lucide-react';
import { api } from '../services/api';
import { useToast } from '../hooks/useToast';
import type { Conversation, FileEntry, ModifiedFile, Message } from '../types';

interface Props {
  conversation: Conversation | null;
  onCreateNew: () => void;
  model: string;
  thinkingEnabled?: boolean;
  onMessageSent: () => void;
  onConversationCreated: (id: string) => void;
  onForkConversation?: (messages: Message[]) => void;
}

export function AgentWorkspace({ conversation, onCreateNew, model, thinkingEnabled = false, onMessageSent, onConversationCreated, onForkConversation }: Props) {
  const [workspacePath, setWorkspacePath] = useState(conversation?.workspacePath || '');
  const [loadedPath, setLoadedPath] = useState(conversation?.workspacePath || '');
  const [planningEnabled, setPlanningEnabled] = useState(false);

  const { messages, isStreaming, sendMessage, regenerate, editMessage, deleteMessage, stopGeneration, currentStage, liveDuration } = useChat(
    model,
    conversation?.messages || [],
    conversation?.id,
    thinkingEnabled,
    'agent',
    workspacePath,
    undefined,
    undefined,
    planningEnabled
  );
  const [showSetup, setShowSetup] = useState(!conversation?.workspacePath);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [browserOpen, setBrowserOpen] = useState(false);
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

  // Fork: create a new conversation from a specific message
  const handleFork = useCallback((index: number) => {
    const forkMessages = messages.slice(0, index + 1);
    onForkConversation?.(forkMessages);
  }, [messages, onForkConversation]);

  // Auto-focus approve or delete button when modal opens
  useEffect(() => {
    if (pendingCode && !applied) {
      requestAnimationFrame(() => approveBtnRef.current?.focus());
    }
    if (pendingDelete) {
      requestAnimationFrame(() => deleteBtnRef.current?.focus());
    }
  }, [pendingCode, applied, pendingDelete]);

  // Detect when streaming ends after planning → show action modal
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      if (planningEnabled && !planActionTakenRef.current) {
        setPlanPending(true);
      }
    }
    wasStreamingRef.current = isStreaming;
    planActionTakenRef.current = false;
  }, [isStreaming, planningEnabled]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      // Escape: stop generation when streaming
      if (e.key === 'Escape' && isStreaming && !isInput) {
        e.preventDefault();
        stopGeneration();
        return;
      }
      // Escape: dismiss approval modal
      if (e.key === 'Escape' && pendingCode && !applied) {
        e.preventDefault();
        handleReject();
        return;
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isStreaming, stopGeneration, pendingCode, applied]);

  const handleApplyCode = useCallback(async (filePath: string, codeContent: string) => {
    // Resolve relative path against workspace path
    const workspaceBase = loadedPath.replace(/\\/g, '/').replace(/\/$/, '');
    const fullPath = loadedPath && !filePath.startsWith('/') && !filePath.includes(':')
      ? workspaceBase + '/' + filePath
      : filePath;

    // Security check: ensure the path is within the workspace
    const normalizedFull = fullPath.replace(/\\/g, '/');
    if (workspaceBase && !normalizedFull.startsWith(workspaceBase)) {
      toast('error', `Cannot write outside workspace: ${filePath}`);
      return;
    }

    // Read existing content
    let oldContent = '';
    try {
      const result = await api.getFileContent(fullPath);
      if (result.content !== null) {
        oldContent = result.content;
      }
    } catch { /* file doesn't exist */ }

    setPendingCode({
      filePath: fullPath,
      oldContent,
      newContent: codeContent,
      fileName: filePath.split('/').pop()?.split('\\').pop() || filePath,
    });
    setApplied(false);
  }, [loadedPath]);

  const handleFileModified = useCallback((filePath: string, changeType: 'created' | 'edited', originalContent?: string) => {
    const fileName = filePath.split('/').pop()?.split('\\').pop() || filePath;
    setModifiedFiles((prev) => {
      // Remove duplicate for same path, add to front
      const filtered = prev.filter((f) => f.filePath !== filePath);
      return [{ filePath, fileName, changeType, originalContent, timestamp: Date.now() }, ...filtered];
    });
  }, []);

  const handleApproveSave = async () => {
    if (!pendingCode) return;
    setApplying(true);
    try {
      await api.writeFile(pendingCode.filePath, pendingCode.newContent);
      handleFileModified(pendingCode.filePath, pendingCode.oldContent ? 'edited' : 'created', pendingCode.oldContent || undefined);
      setApplied(true);
      setTimeout(() => {
        setPendingCode(null);
        setApplied(false);
      }, 2000);
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
        // Resolve path
        const workspaceBase = loadedPath.replace(/\\/g, '/').replace(/\/$/, '');
        const fullPath = loadedPath && !f.filePath.startsWith('/') && !f.filePath.includes(':')
          ? workspaceBase + '/' + f.filePath
          : f.filePath;
        // Security check
        const normalizedFull = fullPath.replace(/\\/g, '/');
        if (workspaceBase && !normalizedFull.startsWith(workspaceBase)) {
          failCount++;
          continue;
        }
        // Check if file exists to determine change type
        let oldContent = '';
        let isEdit = false;
        try {
          const result = await api.getFileContent(fullPath);
          if (result.content !== null) {
            oldContent = result.content;
            isEdit = true;
          }
        } catch { /* new file */ }
        // Save directly (no modal)
        await api.writeFile(fullPath, f.content);
        handleFileModified(fullPath, isEdit ? 'edited' : 'created', isEdit ? oldContent : undefined);
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
  }, [loadedPath, handleFileModified, onMessageSent]);

  const handleDeleteFile = useCallback(async (filePath: string) => {
    // Resolve relative path
    const workspaceBase = loadedPath.replace(/\\/g, '/').replace(/\/$/, '');
    const fullPath = loadedPath && !filePath.startsWith('/') && !filePath.includes(':')
      ? workspaceBase + '/' + filePath
      : filePath;

    // Security check: ensure the path is within the workspace
    const normalizedFull = fullPath.replace(/\\/g, '/');
    if (workspaceBase && !normalizedFull.startsWith(workspaceBase)) {
      toast('error', `Cannot delete outside workspace: ${filePath}`);
      return;
    }

    setPendingDelete(fullPath);
  }, [loadedPath]);

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteFile(pendingDelete);
      onMessageSent();
      setPendingDelete(null);
    } catch (e) {
      console.error('Failed to delete file:', e);
      toast('error', 'Failed to delete file');
    }
    setDeleting(false);
  };

  const handleWorkspaceSelect = async (path: string, name: string) => {
    setWorkspacePath(path);
    setLoadedPath(path);
    setShowSetup(false);
    setBrowserOpen(true);
    // Persist to backend so it's remembered on page reload
    if (conversation?.id) {
      try {
        await api.updateConversation(conversation.id, { workspacePath: path });
        // Refresh sidebar so it groups this conversation under the right project
        onMessageSent();
      } catch (e) {
        console.error('Failed to save workspace path:', e);
      }
    }
  };

  // Plan action handlers
  const handleImplementPlan = useCallback(() => {
    planActionTakenRef.current = true;
    setPlanPending(false);
    setPlanningEnabled(false);
    // Wait for state update to propagate to useChat ref, then send
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
    // Delete the last assistant (plan) message
    const lastIdx = messages.length - 1;
    if (lastIdx >= 0 && messages[lastIdx].role === 'assistant') {
      deleteMessage(lastIdx);
    }
  }, [messages, deleteMessage]);

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
      // Remove from list after brief success indicator
      setTimeout(() => {
        setModifiedFiles((prev) => prev.filter((f) => f.filePath !== mf.filePath));
        setRevertedFiles((prev) => {
          const next = { ...prev };
          delete next[mf.filePath];
          return next;
        });
      }, 1500);
    } catch (e) {
      setRevertError(e instanceof Error ? e.message : 'Failed to revert file');
      setTimeout(() => setRevertError(null), 4000);
    }
    setRevertingFile(null);
  };

  if (!conversation) {
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
            The AI can read and write files in your workspace to help you code.
          </p>
          <div className="flex flex-wrap justify-center gap-3 mb-6 text-xs text-gray-500">
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-800/50 border border-gray-700/50">
              📂 Browse files
            </span>
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-800/50 border border-gray-700/50">
              ✏️ Edit code
            </span>
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-800/50 border border-gray-700/50">
              💬 Ask questions
            </span>
          </div>
          <button
            onClick={onCreateNew}
            className="px-5 py-2.5 bg-gradient-to-r from-purple-600 to-violet-600 hover:from-purple-500 hover:to-violet-500 rounded-xl text-sm font-medium inline-flex items-center gap-2 shadow-lg shadow-purple-600/20 transition-all duration-200 hover:scale-105 active:scale-95"
          >
            <Plus size={16} />
            Start agent session
          </button>
        </div>
      </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
    <div className="flex-1 flex overflow-hidden">
      {/* Workspace setup dialog */}
      {showSetup && (
        <WorkspaceSetup
          defaultBasePath={undefined}
          onSelect={handleWorkspaceSelect}
          onClose={() => setShowSetup(false)}
        />
      )}

      {/* Left: Chat area */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Workspace path header */}
        {workspacePath && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/50">
            <FolderOpen size={14} className="text-purple-400 flex-shrink-0" />
            <span className="text-xs text-gray-400 truncate flex-1">{workspacePath}</span>
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className={`p-1 rounded transition-colors ${
                sidebarOpen ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'
              }`}
              title={sidebarOpen ? 'Close workspace panel' : 'Open workspace panel'}
            >
              {sidebarOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
            </button>
          </div>
        )}

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
        <InputBar
          onSend={handleSend}
          onStop={stopGeneration}
          isStreaming={isStreaming}
          planningEnabled={planningEnabled}
          onPlanningToggle={() => setPlanningEnabled(!planningEnabled)}
        />

        {/* Approval modal overlay */}
        {pendingCode && !applied && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) handleReject(); }}
          >
            <div className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl animate-fade-in">
              {/* Modal header */}
              <div className="flex items-center justify-between p-4 border-b border-gray-800">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-amber-600/20 rounded-xl">
                    <FilePlus2 size={20} className="text-amber-400" />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-white">Approve File Change</h3>
                    <p className="text-xs text-gray-500 mt-0.5">
                      <span className="inline-flex items-center gap-1">
                        <FileCode size={10} />
                        {pendingCode.fileName}
                      </span>
                      <span className="ml-2 text-gray-600">
                        {pendingCode.oldContent ? '✏️ Edit existing file' : '✨ Create new file'}
                      </span>
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleReject}
                  className="p-2 hover:bg-gray-800 rounded-xl text-gray-400 hover:text-gray-200 transition-colors"
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </div>

              {/* File path */}
              <div className="px-4 py-2 bg-gray-950/30 border-b border-gray-800">
                <code className="text-xs text-gray-400 font-mono break-all select-all">
                  {pendingCode.filePath}
                </code>
              </div>

              {/* Diff content */}
              <div className="flex-1 overflow-y-auto p-4">
                <DiffView
                  oldContent={pendingCode.oldContent}
                  newContent={pendingCode.newContent}
                  filename={pendingCode.fileName}
                />
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-800 bg-gray-950/50">
                <button
                  onClick={handleReject}
                  className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors border border-gray-700"
                >
                  <X size={16} />
                  Discard
                </button>
                <button
                  ref={approveBtnRef}
                  onClick={handleApproveSave}
                  disabled={applying}
                  className="flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-emerald-600 to-green-600 hover:from-emerald-500 hover:to-green-500 text-white text-sm font-medium rounded-xl transition-all shadow-lg shadow-emerald-600/20 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {applying ? (
                    <Loader size={16} className="animate-spin" />
                  ) : (
                    <Check size={16} />
                  )}
                  {applying ? 'Saving...' : 'Approve & Save'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Delete confirmation modal */}
        {pendingDelete && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setPendingDelete(null); }}
          >
            <div className="w-full max-w-md bg-gray-900 border border-red-800/50 rounded-2xl shadow-2xl animate-fade-in">
              <div className="flex items-center justify-between p-4 border-b border-gray-800">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-red-600/20 rounded-xl">
                    <Trash2 size={20} className="text-red-400" />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-white">Delete File</h3>
                    <p className="text-xs text-gray-500 mt-0.5">This action cannot be undone</p>
                  </div>
                </div>
                <button
                  onClick={() => setPendingDelete(null)}
                  className="p-2 hover:bg-gray-800 rounded-xl text-gray-400 hover:text-gray-200 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="p-4">
                <p className="text-sm text-gray-300 mb-3">Are you sure you want to delete this file?</p>
                <code className="block text-xs text-gray-400 font-mono break-all bg-gray-950/50 p-3 rounded-lg border border-gray-800 select-all">
                  {pendingDelete}
                </code>
              </div>
              <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-800 bg-gray-950/50">
                <button
                  onClick={() => setPendingDelete(null)}
                  className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors border border-gray-700"
                >
                  Cancel
                </button>
                <button
                  ref={deleteBtnRef}
                  onClick={handleConfirmDelete}
                  disabled={deleting}
                  className="flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white text-sm font-medium rounded-xl transition-all shadow-lg shadow-red-600/20 disabled:opacity-50"
                >
                  {deleting ? (
                    <Loader size={16} className="animate-spin" />
                  ) : (
                    <Trash2 size={16} />
                  )}
                  {deleting ? 'Deleting...' : 'Delete File'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Applied success toast overlay */}
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

        {/* Plan action bar — inline above input, doesn't block the plan view */}
        {planPending && (
          <div className="border-t border-violet-800/30 bg-violet-950/20 px-4 py-2.5">
            <div className="max-w-3xl mx-auto flex items-center gap-3">
              <div className="flex items-center gap-2 text-sm text-violet-300 flex-shrink-0">
                <ClipboardList size={16} />
                <span className="font-medium">Plan ready</span>
              </div>
              <span className="text-xs text-gray-500 hidden sm:inline">
                What would you like to do?
              </span>
              <div className="flex-1" />
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleScrapPlan}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600/10 hover:bg-red-600/20 text-red-400 border border-red-700/30 hover:border-red-700/50 transition-all"
                >
                  <Trash2 size={13} />
                  Scrap
                </button>
                <button
                  onClick={handleEvaluatePlan}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-600/10 hover:bg-amber-600/20 text-amber-400 border border-amber-700/30 hover:border-amber-700/50 transition-all"
                >
                  <Lightbulb size={13} />
                  Opinion
                </button>
                <button
                  onClick={handleImplementPlan}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-700/40 hover:border-emerald-700/60 transition-all"
                >
                  <Play size={13} />
                  Implement
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Right: Workspace sidebar */}
      {sidebarOpen && workspacePath && (
        <div className="w-80 flex-shrink-0 border-l border-gray-800 bg-gray-900/80 overflow-y-auto flex flex-col">
          {/* Sidebar header */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
            <FolderOpen size={14} className="text-purple-400 flex-shrink-0" />
            <span className="text-xs text-gray-300 font-medium truncate flex-1">
              {workspacePath.split('/').pop()?.split('\\').pop() || 'Workspace'}
            </span>
            <button
              onClick={() => setShowSetup(true)}
              className="text-[10px] text-purple-400 hover:text-purple-300 px-1.5 py-0.5 rounded hover:bg-purple-900/20 transition-colors"
            >
              <Pencil size={12} />
            </button>
          </div>

          {/* File browser */}
          <div className="border-b border-gray-800">
            <button
              onClick={() => setBrowserOpen(!browserOpen)}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 hover:bg-gray-800 transition-colors text-xs text-gray-400 font-medium"
            >
              {browserOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <FolderTree size={12} />
              Files
            </button>
            {browserOpen && (
              <div className="max-h-48 overflow-y-auto bg-gray-900/60">
                <FileTree
                  rootPath={loadedPath}
                  onFileSelect={(file) => {
                    setSelectedFile(file);
                  }}
                />
              </div>
            )}
          </div>

          {/* Modified files */}
          <div className="border-b border-gray-800">
            <button
              onClick={() => setShowModified(!showModified)}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 hover:bg-gray-800 transition-colors text-xs text-gray-400 font-medium relative"
            >
              {showModified ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <History size={12} />
              Modified
              {modifiedFiles.length > 0 && (
                <span className="ml-auto text-[10px] text-purple-400">{modifiedFiles.length}</span>
              )}
            </button>
            {showModified && modifiedFiles.length > 0 && (
              <div className="max-h-36 overflow-y-auto">
                {revertError && (
                  <div className="px-3 py-1 text-[10px] text-red-400 bg-red-950/30 flex items-center gap-1.5">
                    <X size={10} className="flex-shrink-0" />
                    <span>{revertError}</span>
                  </div>
                )}
                {modifiedFiles.map((mf) => {
                  const isReverting = revertingFile === mf.filePath;
                  const isReverted = revertedFiles[mf.filePath];
                  return (
                    <div
                      key={mf.filePath + mf.timestamp}
                      className="flex items-center gap-1 px-3 py-1 hover:bg-gray-800 transition-colors group"
                    >
                      <button
                        onClick={() => {
                          setSelectedFile({ name: mf.fileName, path: mf.filePath, type: 'file' });
                        }}
                        className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
                      >
                        <FileCode size={10} className="text-blue-400 flex-shrink-0" />
                        <span className="text-[11px] text-gray-400 truncate">{mf.fileName}</span>
                      </button>
                      {isReverted ? (
                        <Check size={10} className="text-green-400 flex-shrink-0" />
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRevert(mf); }}
                          disabled={isReverting}
                          className="p-0.5 rounded text-gray-600 hover:text-amber-400 hover:bg-gray-700/50 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-30"
                        >
                          {isReverting ? <Loader size={10} className="animate-spin" /> : <Undo2 size={10} />}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* File preview */}
          {selectedFile && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <FilePreview
                filePath={selectedFile.path}
                fileName={selectedFile.name}
                onClose={() => setSelectedFile(null)}
                onSave={handleFileModified}
              />
            </div>
          )}

          {/* Code suggestion panel in sidebar (kept as secondary) */}
          {pendingCode && !applied && (
            <div className="border-t border-gray-800 bg-gray-900/80">
              <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-gray-800">
                <FilePlus2 size={12} className="text-purple-400" />
                <span className="text-xs text-gray-200 font-medium truncate flex-1">
                  {pendingCode.fileName}
                </span>
              </div>
              <div className="max-h-32 overflow-y-auto p-2">
                <DiffView
                  oldContent={pendingCode.oldContent}
                  newContent={pendingCode.newContent}
                  filename={pendingCode.fileName}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
    </ErrorBoundary>
  );
}

