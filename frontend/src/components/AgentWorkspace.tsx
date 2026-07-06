import { useState, useCallback } from 'react';
import { useChat } from '../hooks/useChat';
import { ChatWindow } from './ChatWindow';
import { InputBar } from './InputBar';
import { FileTree } from './FileTree';
import { FilePreview } from './FilePreview';
import { DiffView } from './DiffView';
import { Wrench, FolderOpen, Plus, FolderTree, ChevronDown, FilePlus2, Check, X, Loader } from 'lucide-react';
import { api } from '../services/api';
import type { Conversation, FileEntry } from '../types';

interface Props {
  conversation: Conversation | null;
  onCreateNew: () => void;
  model: string;
  thinkingEnabled?: boolean;
  onMessageSent: () => void;
  onConversationCreated: (id: string) => void;
}

export function AgentWorkspace({ conversation, onCreateNew, model, thinkingEnabled = false, onMessageSent, onConversationCreated }: Props) {
  const { messages, isStreaming, sendMessage, regenerate, editMessage, stopGeneration, currentStage } = useChat(
    model,
    conversation?.messages || [],
    conversation?.id,
    thinkingEnabled
  );

  const [workspacePath, setWorkspacePath] = useState(conversation?.workspacePath || '');
  const [loadedPath, setLoadedPath] = useState(conversation?.workspacePath || '');
  const [browserOpen, setBrowserOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [pendingCode, setPendingCode] = useState<{ filePath: string; oldContent: string; newContent: string; fileName: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

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

  const handlePathSubmit = () => {
    const trimmed = workspacePath.trim();
    if (trimmed) {
      setLoadedPath(trimmed);
      setBrowserOpen(true);
    }
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

  const handleApproveSave = async () => {
    if (!pendingCode) return;
    setApplying(true);
    try {
      await api.writeFile(pendingCode.filePath, pendingCode.newContent);
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

  if (!conversation) {
    return (
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
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Workspace bar */}
      <div className="border-b border-gray-800 bg-gray-900/50">
        <div className="flex items-center gap-2 px-4 py-2">
          <FolderOpen size={16} className="text-purple-400 flex-shrink-0" />
          <input
            type="text"
            placeholder="C:\Users\filik\OneDrive\Dokumenty\AiChat"
            value={workspacePath}
            onChange={(e) => setWorkspacePath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handlePathSubmit(); }}
            className="flex-1 bg-transparent text-sm text-gray-300 placeholder-gray-600 outline-none"
          />
          {workspacePath.trim() && (
            <button
              onClick={handlePathSubmit}
              className="text-xs text-purple-400 hover:text-purple-300 font-medium px-2 py-0.5 rounded hover:bg-purple-900/20 transition-colors"
            >
              Browse
            </button>
          )}
          {loadedPath && (
            <button
              onClick={() => setBrowserOpen(!browserOpen)}
              className={`p-1 rounded transition-colors ${
                browserOpen ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'
              }`}
              title={browserOpen ? 'Close file browser' : 'Open file browser'}
            >
              {browserOpen ? <ChevronDown size={14} /> : <FolderTree size={14} />}
            </button>
          )}
        </div>

        {/* File browser panel */}
        {browserOpen && loadedPath && (
          <div className="border-t border-gray-800 max-h-60 overflow-y-auto bg-gray-900/80">
            <FileTree
              rootPath={loadedPath}
              onFileSelect={(file) => {
                setSelectedFile(file);
              }}
            />
          </div>
        )}

        {/* File preview */}
        {selectedFile && (
          <FilePreview
            filePath={selectedFile.path}
            fileName={selectedFile.name}
            onClose={() => setSelectedFile(null)}
          />
        )}
      </div>

      {/* Code suggestion panel */}
      {pendingCode && (
        <div className="border-b border-gray-800 bg-gray-900/80">
          <div className="px-4 py-2 flex items-center gap-2 border-b border-gray-800">
            <FilePlus2 size={14} className="text-purple-400" />
            <span className="text-sm text-gray-200 font-medium">
              {applied ? 'Applied!' : pendingCode.oldContent ? 'Edit' : 'Create'} {pendingCode.fileName}
            </span>
            <span className="text-[10px] text-gray-600">{pendingCode.filePath}</span>
          </div>
          <div className="p-3 max-h-[30vh] overflow-y-auto">
            <DiffView
              oldContent={pendingCode.oldContent}
              newContent={pendingCode.newContent}
              filename={pendingCode.fileName}
            />
          </div>
          {!applied && (
            <div className="flex items-center gap-2 px-4 py-2 border-t border-gray-800">
              <button
                onClick={handleApproveSave}
                disabled={applying}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {applying ? (
                  <>
                    <Loader size={14} className="animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Check size={14} />
                    Approve & save
                  </>
                )}
              </button>
              <button
                onClick={handleReject}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium rounded-lg transition-colors border border-gray-700"
              >
                <X size={14} />
                Discard
              </button>
            </div>
          )}
        </div>
      )}

      {/* Chat area */}
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
  );
}
