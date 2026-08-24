import { useState, useCallback, useEffect, useRef } from 'react';
import { useChat } from '../hooks/useChat';
import { ChatWindow } from './ChatWindow';
import { InputBar } from './InputBar';
import { FileTree } from './FileTree';

import { DiffView } from './DiffView';
import { ErrorBoundary } from './ErrorBoundary';
import { WorkspaceSetup } from './WorkspaceSetup';
import {
  Wrench, FolderOpen, Plus, ChevronDown, ChevronRight,
  FilePlus2, Check, X, Loader, History, FileCode,
  Undo2, Pencil,
  Trash2, Play, Lightbulb, ClipboardList,
  MessageSquare, GripVertical,
  Bot, Eye, AlertTriangle,
} from 'lucide-react';
import { ServerDownInline } from './ServerDownInline';
import { useServerStatus } from '../hooks/useServerStatus';
import { api } from '../services/api';
import { useToast } from '../hooks/useToast';
import type { Conversation, ModifiedFile, Message } from '../types';

// Per-conversation modified files — survives remounts/conversation switches.
const modifiedFilesCache = new Map<string, ModifiedFile[]>();

// Normalize Windows backslashes so file paths compare/display consistently.
const normPath = (p: string) => p.replace(/\\/g, '/');

interface Props {
  conversation: Conversation | null;
  offlineWorkspace?: string | null;
  onCreateNew: () => void;
  model: string;
  thinkingEnabled?: boolean;
  onMessageSent: () => void;
  onConversationCreated: (id: string) => void;
  /** Fired the moment a new chat's stream starts and the backend assigns its id. */
  onConversationStarted?: (id: string) => void;
  onForkConversation?: (messages: Message[]) => void;
}

export function AgentWorkspace({ conversation, offlineWorkspace, onCreateNew, model, thinkingEnabled = false, onMessageSent, onConversationCreated, onConversationStarted, onForkConversation }: Props) {
  const convKey = conversation?.id || 'offline';
  const [workspacePath, setWorkspacePath] = useState(offlineWorkspace || conversation?.workspacePath || '');
  const [loadedPath, setLoadedPath] = useState(offlineWorkspace || conversation?.workspacePath || '');
  const [planningEnabled, setPlanningEnabled] = useState(false);

  // Auto-apply is always ON — the AI writes/deletes files directly.
  const autoApply = true;

  // Bump to refresh the file tree when the agent writes files
  const [treeRefreshToken, setTreeRefreshToken] = useState(0);

  // Ref to setter so agent callbacks can update modified files
  const modifiedFilesSetterRef = useRef<(fn: (prev: ModifiedFile[]) => ModifiedFile[]) => void>(() => {});
  const modifiedFilesRef = useRef<ModifiedFile[]>([]);
  const { toast } = useToast();

  const handleFileWritten = useCallback((write: { path: string; changeType: string; originalContent?: string }) => {
    const filePath = normPath(write.path);
    const fileName = filePath.split('/').pop() || filePath;
    modifiedFilesSetterRef.current((prev) => {
      const filtered = prev.filter((f) => f.filePath !== filePath);
      return [{
        filePath,
        fileName,
        changeType: write.changeType === 'deleted' ? 'deleted' : (write.changeType === 'edited' ? 'edited' : 'created'),
        originalContent: write.originalContent,
        timestamp: Date.now(),
      }, ...filtered];
    });
    setTreeRefreshToken((t) => t + 1);
  }, []);

  const handleAgentCommand = useCallback((cmd: { command: string; output: string; failed: boolean }) => {
    console.log(`[koding] ${cmd.failed ? '❌' : '$'} ${cmd.command}`);
    if (cmd.output) console.log(cmd.output);
  }, []);

  // ask_user: the agent paused the run to ask a question — show a modal.
  const [pendingQuestion, setPendingQuestion] = useState<{ key: string; question: string } | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{ key: string; tool: string; args: Record<string, unknown> } | null>(null);
  const [questionInput, setQuestionInput] = useState('');
  const [sendingAnswer, setSendingAnswer] = useState(false);

  const handleQuestion = useCallback((q: { key: string; question: string }) => {
    setPendingQuestion(q);
    setQuestionInput('');
  }, []);

  const submitAnswer = async (answer: string) => {
    if (!pendingQuestion || sendingAnswer) return;
    setSendingAnswer(true);
    try {
      await api.answerAgentQuestion(pendingQuestion.key, answer);
    } catch (e: any) {
      console.error('Failed to send answer:', e);
      const msg = e?.message || '';
      if (msg && !/no pending question|not found/i.test(msg)) {
        toast('error', 'Could not send your answer — the agent may have moved on');
      }
    }
    setSendingAnswer(false);
    setPendingQuestion(null);
  };

  const closeQuestion = () => {
    if (pendingQuestion) submitAnswer('(user chose to skip this question)');
  };

  // Phase 3: Tool approval
  const [approving, setApproving] = useState(false);

  const handleApprovalRequest = useCallback((q: { key: string; tool: string; args: Record<string, unknown> }) => {
    setPendingApproval(q);
  }, []);

  const respondApproval = async (approved: boolean) => {
    if (!pendingApproval || approving) return;
    setApproving(true);
    try {
      await api.approveAgentTool(pendingApproval.key, approved);
    } catch (e: any) {
      console.error('Failed to send approval:', e);
      toast('error', 'Could not send approval — the agent may have moved on');
    }
    setApproving(false);
    setPendingApproval(null);
  };

  const { messages, isStreaming, sendMessage, regenerate, editMessage, deleteMessage, stopGeneration, currentStage, stageHistory, liveDuration } = useChat(
    model,
    conversation?.messages || [],
    conversation?.id,
    thinkingEnabled,
    'agent',
    workspacePath,
    undefined,
    planningEnabled,
    autoApply,
    undefined,
    handleFileWritten,
    handleAgentCommand,
    handleQuestion,
    onConversationStarted,
    handleApprovalRequest
  );

  // ─── Layout State ──────────────────────────────────────────
  const [showSetup, setShowSetup] = useState(!offlineWorkspace && !conversation?.workspacePath);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [leftWidth, setLeftWidth] = useState(224);
  const dragRef = useRef<{ type: 'left'; startX: number; startSize: number } | null>(null);

  // ─── File Modified State ───────────────────────────────────
  const [modifiedFiles, setModifiedFiles] = useState<ModifiedFile[]>(() => modifiedFilesCache.get(convKey) || []);
  modifiedFilesSetterRef.current = setModifiedFiles;
  modifiedFilesRef.current = modifiedFiles;

  // Persist per-conversation modified files across remounts/conversation switches.
  const prevConvRef = useRef<string>(convKey);
  useEffect(() => {
    const prev = prevConvRef.current;
    if (prev !== convKey) {
      modifiedFilesCache.set(prev, modifiedFilesRef.current);
      setModifiedFiles(modifiedFilesCache.get(convKey) || []);
      prevConvRef.current = convKey;
    }
  }, [convKey]);

  const [showModified, setShowModified] = useState(false);
  const [diffPreview, setDiffPreview] = useState<{ filePath: string; fileName: string; oldContent: string; newContent: string } | null>(null);
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

  // Code approval state
  const [pendingCode, setPendingCode] = useState<{ filePath: string; oldContent: string; newContent: string; fileName: string; isEdit?: boolean; editOldString?: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

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

  // ─── AI Code Apply Handlers ────────────────────────────────
  const resolveApplyPath = useCallback(async (candidate: string): Promise<string> => {
    const workspaceBase = loadedPath.replace(/\\\\/g, '/').replace(/\/$/, '');
    const fullPath = loadedPath && !candidate.startsWith('/') && !candidate.includes(':')
      ? workspaceBase + '/' + candidate
      : candidate;
    try {
      const result = await api.getFileContent(fullPath, loadedPath);
      if (result.content !== null) return fullPath;
    } catch { /* missing */ }
    const baseName = fullPath.split('/').pop()?.split('\\\\').pop()?.toLowerCase();
    if (!baseName || !workspaceBase) return fullPath;
    const matches: string[] = [];
    const ignoredDirs = new Set(['node_modules', '.git', 'dist', 'build', '.cache', 'coverage', 'target', 'vendor', '.venv', 'venv', '.next', '.nuxt']);
    const walk = async (dir: string, depth: number) => {
      if (depth > 4 || matches.length > 10) return;
      const data = await api.getFiles(dir);
      const entries = data.entries || [];
      for (const e of entries) {
        if (e.type === 'directory') {
          if (e.name.startsWith('.') || ignoredDirs.has(e.name)) continue;
          await walk(e.path.replace(/\\/g, '/'), depth + 1);
        } else if (e.name.toLowerCase() === baseName) {
          matches.push(e.path.replace(/\\/g, '/'));
        }
      }
    };
    await walk(workspaceBase, 0);
    if (matches.length === 1) {
      toast('info', `The file is at ${matches[0]} — applying there instead of ${fullPath}`);
      return matches[0];
    }
    return fullPath;
  }, [loadedPath, toast]);

  const handleApplyCode = useCallback(async (filePath: string, codeContent: string) => {
    const workspaceBase = loadedPath.replace(/\\\\/g, '/').replace(/\/$/, '');
    const fullPath = await resolveApplyPath(filePath);
    if (!fullPath.replace(/\\\\/g, '/').startsWith(workspaceBase)) {
      toast('error', `Cannot write outside workspace: ${filePath}`);
      return;
    }
    let oldContent = '';
    try {
      const result = await api.getFileContent(fullPath, loadedPath);
      if (result.content !== null) oldContent = result.content;
    } catch { /* file doesn't exist */ }
    setPendingCode({
      filePath: fullPath,
      oldContent,
      newContent: codeContent,
      fileName: filePath.split('/').pop()?.split('\\\\').pop() || filePath,
    });
    setApplied(false);
  }, [loadedPath, toast, resolveApplyPath]);

  const handleApplyEdit = useCallback(async (filePath: string, oldString: string, newString: string) => {
    const workspaceBase = loadedPath.replace(/\\\\/g, '/').replace(/\/$/, '');
    const fullPath = await resolveApplyPath(filePath);
    if (!fullPath.replace(/\\\\/g, '/').startsWith(workspaceBase)) {
      toast('error', `Cannot edit outside workspace: ${filePath}`);
      return;
    }
    let oldContent = '';
    try {
      const result = await api.getFileContent(fullPath, loadedPath);
      if (result.content !== null) oldContent = result.content;
    } catch { /* file doesn't exist */ }
    setPendingCode({
      filePath: fullPath,
      oldContent,
      newContent: newString,
      editOldString: oldString,
      isEdit: true,
      fileName: filePath.split('/').pop()?.split('\\\\').pop() || filePath,
    });
    setApplied(false);
  }, [loadedPath, toast, resolveApplyPath]);

  const handleApproveSave = async () => {
    if (!pendingCode) return;
    setApplying(true);
    try {
      if (pendingCode.isEdit) {
        await api.editFile(pendingCode.filePath, pendingCode.editOldString!, pendingCode.newContent, loadedPath);
      } else {
        await api.writeFile(pendingCode.filePath, pendingCode.newContent, loadedPath);
      }
      const fileName = pendingCode.filePath.split('/').pop()?.split('\\\\').pop() || pendingCode.filePath;
      setModifiedFiles((prev) => {
        const filtered = prev.filter((f) => f.filePath !== pendingCode.filePath);
        return [{ filePath: pendingCode.filePath, fileName, changeType: pendingCode.oldContent ? 'edited' : 'created', originalContent: pendingCode.oldContent || undefined, timestamp: Date.now() }, ...filtered];
      });
      setApplied(true);
      setTimeout(() => { setPendingCode(null); setApplied(false); }, 2000);
      onMessageSent();
    } catch (e: any) {
      console.error('Failed to save file:', e);
      toast('error', (e?.message || e?.error || 'Failed to save file').slice(0, 200));
    }
    setApplying(false);
  };

  const handleReject = useCallback(() => {
    setPendingCode(null);
    setApplied(false);
  }, []);

  const handleApplyAll = useCallback(async (files: { filePath: string; content: string; oldString?: string; newString?: string }[]) => {
    let successCount = 0;
    let failCount = 0;
    for (const f of files) {
      try {
        const workspaceBase = loadedPath.replace(/\\\\/g, '/').replace(/\/$/, '');
        const fullPath = await resolveApplyPath(f.filePath);
        if (!fullPath.replace(/\\\\/g, '/').startsWith(workspaceBase)) { failCount++; continue; }

        let oldContent: string | undefined;
        try {
          const result = await api.getFileContent(fullPath, loadedPath);
          if (result.content !== null) oldContent = result.content;
        } catch { /* new file */ }

        if (f.oldString !== undefined && f.newString !== undefined) {
          await api.editFile(fullPath, f.oldString, f.newString, loadedPath);
        } else {
          await api.writeFile(fullPath, f.content, loadedPath);
        }

        const fileName = fullPath.split('/').pop()?.split('\\\\').pop() || fullPath;
        const changeType: 'created' | 'edited' = oldContent !== undefined ? 'edited' : 'created';
        setModifiedFiles((prev) => {
          const filtered = prev.filter((mf) => mf.filePath !== fullPath);
          return [{ filePath: fullPath, fileName, changeType, originalContent: oldContent, timestamp: Date.now() }, ...filtered];
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
  }, [loadedPath, onMessageSent, toast, resolveApplyPath]);

  const handleFileModified = useCallback((filePath: string, changeType: 'created' | 'edited', originalContent?: string) => {
    const fileName = filePath.split('/').pop()?.split('\\\\').pop() || filePath;
    setModifiedFiles((prev) => {
      const filtered = prev.filter((f) => f.filePath !== filePath);
      return [{ filePath, fileName, changeType, originalContent, timestamp: Date.now() }, ...filtered];
    });
  }, []);

  const handleDeleteFile = useCallback(async (filePath: string) => {
    const workspaceBase = loadedPath.replace(/\\\\/g, '/').replace(/\/$/, '');
    const fullPath = await resolveApplyPath(filePath);
    if (!fullPath.replace(/\\\\/g, '/').startsWith(workspaceBase)) {
      toast('error', `Cannot delete outside workspace: ${filePath}`);
      return;
    }
    setPendingDelete(fullPath);
  }, [loadedPath, toast, resolveApplyPath]);

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteFile(pendingDelete, loadedPath);
      onMessageSent();
      setPendingDelete(null);
    } catch (e) {
      console.error('Failed to delete file:', e);
      toast('error', 'Failed to delete file');
    }
    setDeleting(false);
  };

  const handleViewDiff = useCallback(async (mf: ModifiedFile) => {
    try {
      const result = await api.getFileContent(mf.filePath, loadedPath);
      if (result.content === null || result.binary) {
        toast('error', 'Cannot show a diff for this file (binary or unreadable)');
        return;
      }
      setDiffPreview({
        filePath: mf.filePath,
        fileName: mf.fileName,
        oldContent: mf.originalContent ?? '',
        newContent: result.content,
      });
    } catch (e) {
      console.error('Failed to load diff:', e);
      toast('error', 'Could not load the file to diff');
    }
  }, [loadedPath, toast]);

  const handleRevert = async (mf: ModifiedFile) => {
    setRevertingFile(mf.filePath);
    setRevertError(null);
    try {
      if (mf.changeType === 'created') {
        await api.deleteFile(mf.filePath, loadedPath);
      } else if (mf.changeType === 'deleted') {
        if (mf.originalContent !== undefined) {
          await api.writeFile(mf.filePath, mf.originalContent, loadedPath);
        }
      } else if (mf.originalContent !== undefined) {
        await api.writeFile(mf.filePath, mf.originalContent, loadedPath);
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
  const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent, type: 'left') => {
    e.preventDefault();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    dragRef.current = { type, startX: clientX, startSize: leftWidth };
  }, [leftWidth]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent | TouchEvent) => {
      if (!dragRef.current) return;
      const clientX = 'touches' in e ? (e as TouchEvent).touches[0].clientX : (e as MouseEvent).clientX;
      const delta = clientX - dragRef.current.startX;
      setLeftWidth(Math.max(120, Math.min(400, dragRef.current.startSize + delta)));
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

  // Empty state — no conversation selected
  if (!conversation && !offlineWorkspace) {
    return (
      <ErrorBoundary>
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-md animate-fade-in">
            <div className="relative mx-auto mb-6">
              <div className="w-20 h-20 mx-auto rounded-lg bg-[#2a3a52] flex items-center justify-center">
                <Wrench size={36} className="text-white"/>
              </div>
              <div className="absolute -bottom-1 -right-1 w-7 h-7 bg-emerald-500 rounded-full flex items-center justify-center border-2 border-gray-950">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </div>
            </div>
            <h2 className="text-2xl font-semibold text-white mb-2">Koding</h2>
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
                message="Start a session to browse and edit files."
                onRetry={() => window.location.reload()}
              />
            ) : (
              <button onClick={onCreateNew}
                className="px-5 py-2.5 bg-[#2a3a52] hover:bg-[#345070] rounded-xl text-sm font-medium inline-flex items-center gap-2 transition-all duration-200 hover:scale-105 active:scale-95"
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
              <FolderOpen size={12} className="text-[#7b9fc6] flex-shrink-0"/>
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
                workspacePath={loadedPath}
                refreshToken={treeRefreshToken}
                onFileSelect={() => {}}
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
                  <span className="ml-auto text-[10px] text-[#7b9fc6]">{modifiedFiles.length}</span>
                )}
              </button>
              {showModified && modifiedFiles.length > 0 && (
                <div className="max-h-28 overflow-y-auto">
                  {revertError && (
                    <div className="px-2 py-0.5 text-[10px] text-[#c44] bg-red-950/30 flex items-center gap-1">
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
                        <button onClick={() => handleViewDiff(mf)}
                          className="flex items-center gap-1 min-w-0 flex-1 text-left"
                          title="View changes"
                        >
                          <FileCode size={8} className="text-[#7b9fc6] flex-shrink-0"/>
                          <span className="truncate text-gray-400">{mf.fileName}</span>
                        </button>
                        <button onClick={() => handleViewDiff(mf)}
                          className="p-0.5 rounded text-gray-600 hover:text-[#7b9fc6] opacity-0 group-hover:opacity-100 transition-all"
                          title="View diff"
                        >
                          <Eye size={9} />
                        </button>
                        {isReverted ? (
                          <Check size={8} className="text-green-400"/>
                        ) : (
                          <button onClick={() => handleRevert(mf)} disabled={isReverting}
                            className="p-0.5 rounded text-gray-600 hover:text-[#b8966a] opacity-0 group-hover:opacity-100 transition-all disabled:opacity-30"
                            title="Revert"
                          >
                            {isReverting ? <Loader size={8} className="animate-spin"/> : <Undo2 size={8} />}
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
            <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-3"/>
            <GripVertical size={10} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity"/>
          </div>
        )}

        {/* ═══ MAIN AREA: Chat (full width) ═══ */}
        <div className="flex-1 flex flex-col min-w-0 bg-gray-900/80">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
            <div className="flex items-center gap-2">
              <MessageSquare size={14} className="text-[#7b9fc6]"/>
              <span className="text-xs text-gray-300 font-medium">Koding</span>
              {workspacePath && (
                <span className="text-[10px] text-gray-500 font-mono truncate max-w-48">{workspacePath.split('/').pop()?.split('\\\\').pop() || workspacePath}</span>
              )}
              {isStreaming && (
                <span className="flex items-center gap-1 text-[10px] text-[#7b9fc6]">
                  <span className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-pulse"/>
                  Streaming
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setLeftPanelOpen(!leftPanelOpen)}
                className={`p-1 rounded transition-colors ${leftPanelOpen ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
                title={leftPanelOpen ? 'Hide file tree' : 'Show file tree'}
              >
                <FolderOpen size={12} />
              </button>
            </div>
          </div>

          {/* Chat messages */}
          <div className="flex-1 min-h-0 flex flex-col">
            {!online && messages.length === 0 ? (
              <ServerDownInline
                compact
                message="AI chat is unavailable while the server is offline."
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
                onApplyEdit={handleApplyEdit}
                onDeleteFile={handleDeleteFile}
                onApplyAll={handleApplyAll}
                onFork={handleFork}
              />
            )}
          </div>

          {/* Plan action bar */}
          {planPending && (
            <div className="border-t border-violet-800/30 bg-violet-950/20 px-3 py-1.5">
              <div className="flex items-center gap-1.5">
                <ClipboardList size={12} className="text-violet-300"/>
                <span className="text-[10px] text-violet-300 flex-1">Plan ready</span>
                <button onClick={handleScrapPlan}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-red-600/10 hover:bg-red-600/20 text-[#c44]"
                >
                  <Trash2 size={10} />
                </button>
                <button onClick={handleEvaluatePlan}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-amber-600/10 hover:bg-amber-600/20 text-[#b8966a]"
                >
                  <Lightbulb size={10} />
                </button>
                <button onClick={handleImplementPlan}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-600/20 hover:bg-emerald-600/30 text-[#4a9988]"
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
            draftKey={convKey}
          />
        </div>
      </div>

      {/* ═══ MODALS ═══ */}

      {/* Approval modal */}
      {pendingCode && !applied && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70"
          onClick={(e) => { if (e.target === e.currentTarget) handleReject(); }}
        >
          <div className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-gray-900 border border-gray-700 rounded-lg animate-fade-in">
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-amber-600/20">
                  <FilePlus2 size={20} className="text-[#b8966a]"/>
                </div>
                <div>
                  <h3 className="text-base font-semibold text-white">{pendingCode.isEdit ? 'Approve Edit' : 'Approve File Change'}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    <FileCode size={10} className="inline"/> {pendingCode.fileName}
                    <span className="ml-2 text-gray-600">
                      {pendingCode.isEdit
                        ? '✂️ Surgical edit'
                        : pendingCode.oldContent ? '✏️ Rewrite' : '✨ New'}
                    </span>
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
              {pendingCode.isEdit ? (
                <DiffView oldContent={pendingCode.editOldString || ''} newContent={pendingCode.newContent} filename={pendingCode.fileName} />
              ) : (
                <DiffView oldContent={pendingCode.oldContent} newContent={pendingCode.newContent} filename={pendingCode.fileName} />
              )}
            </div>
            <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-800 bg-gray-950/50">
              <button onClick={handleReject}
                className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors border border-gray-700"
              ><X size={16} /> Discard</button>
              <button ref={approveBtnRef} onClick={handleApproveSave} disabled={applying}
                className="flex items-center gap-2 px-5 py-2 bg-[#1a3a33] hover:bg-[#24504a] text-white text-sm font-medium rounded-xl transition-all disabled:opacity-50"
              >
                {applying ? <Loader size={16} className="animate-spin"/> : <Check size={16} />}
                {applying ? 'Saving...' : 'Approve & Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Diff preview modal */}
      {diffPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70"
          onClick={(e) => { if (e.target === e.currentTarget) setDiffPreview(null); }}
        >
          <div className="w-full max-w-3xl max-h-[85vh] flex flex-col bg-gray-900 border border-gray-700 rounded-lg animate-fade-in">
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-[#2a3a52]/20"><FileCode size={20} className="text-[#7b9fc6]"/></div>
                <div>
                  <h3 className="text-base font-semibold text-white">File Changes</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{diffPreview.fileName}</p>
                </div>
              </div>
              <button onClick={() => setDiffPreview(null)}
                className="p-2 hover:bg-gray-800 rounded-xl text-gray-400 hover:text-gray-200 transition-colors"
              ><X size={18} /></button>
            </div>
            <div className="px-4 py-2 bg-gray-950/30 border-b border-gray-800">
              <code className="text-xs text-gray-400 font-mono break-all select-all">{diffPreview.filePath}</code>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {diffPreview.oldContent === '' && diffPreview.newContent !== '' && (
                <p className="text-xs text-gray-500 mb-2">New file — no previous version to compare against.</p>
              )}
              <DiffView oldContent={diffPreview.oldContent} newContent={diffPreview.newContent} filename={diffPreview.fileName} />
            </div>
            <div className="flex items-center justify-end p-4 border-t border-gray-800 bg-gray-950/50">
              <button onClick={() => setDiffPreview(null)}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors border border-gray-700"
              >Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Agent question modal */}
      {pendingQuestion && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70"
          onClick={(e) => { if (e.target === e.currentTarget) closeQuestion(); }}
        >
          <div className="w-full max-w-lg bg-gray-900 border border-[#2a3a52] rounded-lg animate-fade-in">
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-[#1a2a3a] rounded-xl"><Bot size={20} className="text-[#7b9fc6]"/></div>
                <div><h3 className="text-base font-semibold text-white">The AI needs your input</h3><p className="text-xs text-gray-500 mt-0.5">The run is paused until you answer</p></div>
              </div>
              <button onClick={closeQuestion}
                className="p-2 hover:bg-gray-800 rounded-xl text-gray-400 hover:text-gray-200 transition-colors"
              ><X size={18} /></button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-sm text-gray-200 leading-relaxed">{pendingQuestion.question}</p>
              <input
                type="text"
                value={questionInput}
                onChange={(e) => setQuestionInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && questionInput.trim()) submitAnswer(questionInput.trim()); }}
                placeholder="Type your answer..."
                autoFocus
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-xl text-sm text-white placeholder-gray-500 outline-none focus:border-purple-600 focus:ring-1 focus:ring-purple-600/30 transition-all"
              />
            </div>
            <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-800 bg-gray-950/50">
              <button onClick={() => submitAnswer('(user chose to skip this question)')} disabled={sendingAnswer}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors border border-gray-700 disabled:opacity-50"
              >Skip</button>
              <button onClick={() => submitAnswer(questionInput.trim())} disabled={sendingAnswer || !questionInput.trim()}
                className="flex items-center gap-2 px-5 py-2 bg-[#2a3a52] hover:bg-[#345070] text-white text-sm font-medium rounded-xl transition-all disabled:opacity-50"
              >
                {sendingAnswer ? <Loader size={16} className="animate-spin"/> : <Check size={16} />}
                Send
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tool approval modal */}
      {pendingApproval && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70"
          onClick={(e) => { if (e.target === e.currentTarget) respondApproval(false); }}
        >
          <div className="w-full max-w-md bg-gray-900 border border-[#5a4a30] rounded-lg animate-fade-in">
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-amber-600/20 rounded-xl"><AlertTriangle size={20} className="text-[#b8966a]"/></div>
                <div><h3 className="text-base font-semibold text-white">Tool Approval</h3><p className="text-xs text-gray-500 mt-0.5">The agent wants to execute a tool</p></div>
              </div>
            </div>
            <div className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono px-2 py-1 rounded bg-amber-900/30 text-[#d4b68a] border border-[#5a4a30]">{pendingApproval.tool}</span>
              </div>
              <pre className="text-xs text-gray-400 font-mono bg-gray-800/50 rounded-xl p-3 max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
                {JSON.stringify(pendingApproval.args, null, 2)}
              </pre>
              <p className="text-xs text-gray-500">Allow this tool to execute?</p>
            </div>
            <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-800 bg-gray-950/50">
              <button onClick={() => respondApproval(false)} disabled={approving}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors border border-gray-700 disabled:opacity-50"
              >Deny</button>
              <button onClick={() => respondApproval(true)} disabled={approving}
                className="flex items-center gap-2 px-5 py-2 bg-[#1a3a33] hover:bg-[#24504a] text-white text-sm font-medium rounded-xl transition-all disabled:opacity-50"
              >
                {approving ? <Loader size={16} className="animate-spin"/> : <Check size={16} />}
                Approve
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70"
          onClick={(e) => { if (e.target === e.currentTarget) setPendingDelete(null); }}
        >
          <div className="w-full max-w-md bg-gray-900 border border-[#5a3030] rounded-lg animate-fade-in">
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-red-600/20 rounded-xl"><Trash2 size={20} className="text-[#c44]"/></div>
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
                className="flex items-center gap-2 px-5 py-2 bg-[#5a3030] hover:bg-[#6a4040] text-white text-sm font-medium rounded-xl transition-all disabled:opacity-50"
              >
                {deleting ? <Loader size={16} className="animate-spin"/> : <Trash2 size={16} />}
                {deleting ? 'Deleting...' : 'Delete File'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Applied toast */}
      {pendingCode && applied && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="w-80 flex flex-col items-center gap-4 p-8 bg-gray-900 border border-[#1a3a33] rounded-lg animate-fade-in">
            <div className="w-16 h-16 rounded-full bg-emerald-600/20 flex items-center justify-center">
              <Check size={32} className="text-[#4a9988]"/>
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
