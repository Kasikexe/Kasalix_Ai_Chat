import { useState, useCallback } from 'react';
import { useChat } from '../hooks/useChat';
import { ChatWindow } from './ChatWindow';
import { InputBar } from './InputBar';
import { FileTree } from './FileTree';
import { FilePreview } from './FilePreview';
import { DiffView } from './DiffView';
import { ErrorBoundary } from './ErrorBoundary';
import { WorkspaceSetup } from './WorkspaceSetup';
import { Wrench, FolderOpen, Plus, FolderTree, ChevronDown, ChevronRight, FilePlus2, Check, X, Loader, History, FileCode, Undo2, Pencil, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { api } from '../services/api';
import type { Conversation, FileEntry, ModifiedFile } from '../types';

interface Props {
  conversation: Conversation | null;
  onCreateNew: () => void;
  model: string;
  thinkingEnabled?: boolean;
  onMessageSent: () => void;
  onConversationCreated: (id: string) => void;
}

export function AgentWorkspace({ conversation, onCreateNew, model, thinkingEnabled = false, onMessageSent, onConversationCreated }: Props) {
  const [workspacePath, setWorkspacePath] = useState(conversation?.workspacePath || '');
  const [loadedPath, setLoadedPath] = useState(conversation?.workspacePath || '');

  const { messages, isStreaming, sendMessage, regenerate, editMessage, stopGeneration, currentStage } = useChat(
    model,
    conversation?.messages || [],
    conversation?.id,
    thinkingEnabled,
    'agent',
    workspacePath
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



  const handleApplyCode = useCallback(async (filePath: string, codeContent: string) => {
    // Resolve relative path against workspace path
    const fullPath = loadedPath && !filePath.startsWith('/') && !filePath.includes(':')
      ? loadedPath.replace(/\\/g, '/').replace(/\/$/, '') + '/' + filePath
      : filePath;

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

  const handleReject = () => {
    setPendingCode(null);
    setApplied(false);
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
      } catch (e) {
        console.error('Failed to save workspace path:', e);
      }
    }
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
        <div className="text-center max-w-md">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center mb-4 shadow-lg">
            <Wrench size={28} className="text-white" />
          </div>
          <h2 className="text-2xl font-semibold text-white mb-2">Agent Mode</h2>
          <p className="text-gray-400 mb-6">
            The AI can read and write files in your workspace to help you with coding tasks.
          </p>
          <button
            onClick={onCreateNew}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium inline-flex items-center gap-2"
          >
            <Plus size={16} />
            Start agent session
          </button>          </div>
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
          defaultBasePath="C:\Users\filik\OneDrive\Dokumenty\AiChat"
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
          onEdit={handleEdit}
          onRegenerate={handleRegenerate}
          onApplyCode={handleApplyCode}
        />
        <InputBar onSend={handleSend} onStop={stopGeneration} isStreaming={isStreaming} />
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

          {/* Code suggestion panel */}
          {pendingCode && (
            <div className="border-t border-gray-800 bg-gray-900/80">
              <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-gray-800">
                <FilePlus2 size={12} className="text-purple-400" />
                <span className="text-xs text-gray-200 font-medium truncate flex-1">
                  {applied ? 'Applied!' : pendingCode.fileName}
                </span>
              </div>
              <div className="max-h-48 overflow-y-auto p-2">
                <DiffView
                  oldContent={pendingCode.oldContent}
                  newContent={pendingCode.newContent}
                  filename={pendingCode.fileName}
                />
              </div>
              {!applied && (
                <div className="flex items-center gap-1 px-3 py-1.5 border-t border-gray-800">
                  <button
                    onClick={handleApproveSave}
                    disabled={applying}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1 bg-green-600 hover:bg-green-700 text-white text-[10px] font-medium rounded transition-colors disabled:opacity-50"
                  >
                    {applying ? <Loader size={10} className="animate-spin" /> : <Check size={10} />}
                    {applying ? 'Saving...' : 'Approve'}
                  </button>
                  <button
                    onClick={handleReject}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 text-[10px] font-medium rounded transition-colors border border-gray-700"
                  >
                    <X size={10} />
                    Discard
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
    </ErrorBoundary>
  );
}

