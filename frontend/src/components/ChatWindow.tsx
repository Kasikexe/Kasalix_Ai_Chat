import { useEffect, useRef, useState, useMemo } from 'react';
import { Message } from './Message';
import { ServerDownInline } from './ServerDownInline';
import { useServerStatus } from '../hooks/useServerStatus';
import type { Message as MessageType } from '../types';
import { Search, X, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';

interface Props {
  messages: MessageType[];
  isStreaming: boolean;
  currentStage?: string;
  liveDuration?: number;
  onEdit?: (index: number, newContent: string) => void;
  onDelete?: (index: number) => void;
  onRegenerate?: () => void;
  onApplyCode?: (filePath: string, codeContent: string) => void;
  onApplyEdit?: (filePath: string, oldString: string, newString: string) => void;
  onApplyAll?: (files: { filePath: string; content: string; oldString?: string; newString?: string }[]) => void;
  searchQuery?: string;
  onSearchQueryChange?: (query: string) => void;
  searchMatches?: number[];
  activeSearchMatch?: number;
  onSearchNext?: () => void;
  onSearchPrev?: () => void;
  selectedIndices?: number[];
  onToggleSelect?: (index: number) => void;
  selectable?: boolean;
  onFork?: (index: number) => void;
  onDeleteFile?: (filePath: string) => void;
}

export function ChatWindow({ messages, isStreaming, currentStage, liveDuration, onEdit, onDelete, onRegenerate, onApplyCode, onApplyEdit, onApplyAll, onDeleteFile, searchQuery, onSearchQueryChange, searchMatches, activeSearchMatch, onSearchNext, onSearchPrev, selectedIndices, onToggleSelect, selectable, onFork }: Props) {
  const { online } = useServerStatus();
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      setStickToBottom(scrollHeight - scrollTop - clientHeight < 80);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (stickToBottom && !searchQuery) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, stickToBottom, searchQuery]);

  const isEmpty = messages.length === 0;

  // Scroll to active search match
  useEffect(() => {
    if (activeSearchMatch !== undefined && searchMatches && searchMatches.length > 0) {
      const el = containerRef.current;
      if (!el) return;
      const matchIndex = searchMatches[activeSearchMatch];
      const messageEl = el.querySelector(`[data-msg-index="${matchIndex}"]`);
      if (messageEl) {
        messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [activeSearchMatch, searchMatches]);

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto relative">
      {/* Search bar */}
      {searchQuery !== undefined && onSearchQueryChange && (
        <div className="sticky top-0 z-20 px-3 pt-2 pb-1.5 bg-gray-950/90 backdrop-blur-sm border-b border-gray-800">
          <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5">
            <Search size={14} className="text-gray-400 flex-shrink-0" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              placeholder="Search messages..."
              className="flex-1 bg-transparent text-xs text-white placeholder-gray-500 outline-none"
              autoFocus
            />
            {searchMatches && searchMatches.length > 0 && (
              <span className="text-xs text-gray-500 tabular-nums flex-shrink-0">
                {(activeSearchMatch ?? 0) + 1}/{searchMatches.length}
              </span>
            )}
            {onSearchPrev && (
              <button onClick={onSearchPrev} className="p-0.5 hover:bg-gray-700 rounded text-gray-400" disabled={!searchMatches || searchMatches.length === 0}>
                <ChevronUp size={14} />
              </button>
            )}
            {onSearchNext && (
              <button onClick={onSearchNext} className="p-0.5 hover:bg-gray-700 rounded text-gray-400" disabled={!searchMatches || searchMatches.length === 0}>
                <ChevronDown size={14} />
              </button>
            )}
            <button onClick={() => { onSearchQueryChange(''); }} className="p-0.5 hover:bg-gray-700 rounded text-gray-400">
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Scroll to bottom button */}
      {!stickToBottom && !isEmpty && !searchQuery && (
        <button
          onClick={() => {
            setStickToBottom(true);
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
          }}
          className="fixed bottom-24 right-8 z-20 w-10 h-10 bg-blue-600 hover:bg-blue-500 text-white rounded-full shadow-lg flex items-center justify-center transition-all duration-200 hover:scale-110 active:scale-95"
          title="Scroll to bottom"
        >
          <ChevronDown size={20} />
        </button>
      )}

      {/* Multi-select delete bar */}
      {selectable && selectedIndices && selectedIndices.length > 0 && (
        <div className="sticky bottom-0 z-20 px-4 py-2 bg-red-950/80 backdrop-blur-sm border-t border-red-800/50 flex items-center justify-between">
          <span className="text-xs text-red-300">
            {selectedIndices.length} message{selectedIndices.length !== 1 ? 's' : ''} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => selectedIndices.forEach((i) => onDelete?.(i))}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-xs font-medium rounded-lg transition-colors"
            >
              <Trash2 size={12} />
              Delete selected
            </button>
            <button
              onClick={() => selectedIndices.forEach((i) => onToggleSelect?.(i))}
              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium rounded-lg transition-colors border border-gray-700"
            >
              Deselect all
            </button>
          </div>
        </div>
      )}

      {isEmpty ? (
        !online ? (
          <ServerDownInline
            compact
            message="The AI features are unavailable while the server is disconnected. The rest of the app still works."
            onRetry={() => window.location.reload()}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center px-4 text-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center mb-4 shadow-lg">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                <path d="M12 8V4H8" />
                <rect width="16" height="12" x="4" y="8" rx="2" />
                <path d="M2 14h2" />
                <path d="M20 14h2" />
                <path d="M15 13v2" />
                <path d="M9 13v2" />
              </svg>
            </div>
            <h2 className="text-2xl font-semibold text-white mb-2">How can I help you today?</h2>
            <p className="text-gray-400 max-w-md">
              Start a conversation with your local AI model. Ask questions, get help with code, write content, or just chat.
            </p>
          </div>
        )
      ) : (
        <div className="max-w-3xl mx-auto pb-4">
          {messages.map((msg, i) => {
            const isLast = i === messages.length - 1;
            const streaming = isStreaming && isLast && msg.role === 'assistant';
            const isLastAssistant = !streaming && i === messages.length - 1 && msg.role === 'assistant';
            const isSearchMatch = searchQuery ? searchMatches?.includes(i) ?? false : false;
            const isActiveMatch = activeSearchMatch !== undefined && searchMatches?.[activeSearchMatch] === i;
            return (
              <div
                key={i}
                data-msg-index={i}
                className={`transition-colors duration-200 ${
                  isActiveMatch ? 'bg-blue-900/20 border-y border-blue-700/30 -mx-2 px-2' : ''
                } ${isSearchMatch && !isActiveMatch ? 'bg-blue-900/5' : ''}`}
              >
                <Message
                  index={i}
                  message={msg}
                  isStreaming={streaming}
                  stage={streaming ? currentStage : undefined}
                  liveDuration={streaming ? liveDuration : undefined}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onRegenerate={isLastAssistant ? onRegenerate : undefined}
                  isLastAssistant={isLastAssistant}
                  onApplyCode={onApplyCode}
                  onApplyEdit={onApplyEdit}
                  onDeleteFile={onDeleteFile}
                  onApplyAll={onApplyAll}
                  selected={selectedIndices?.includes(i) ?? false}
                  onToggleSelect={selectable ? onToggleSelect : undefined}
                  selectable={selectable}
                  onFork={onFork}
                />
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
