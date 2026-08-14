import { useCallback, useMemo, useState } from 'react';
import { useChat } from '../hooks/useChat';
import { ChatWindow } from './ChatWindow';
import { InputBar } from './InputBar';
import type { Message } from '../types';

interface Props {
  initialMessages: Message[];
  conversationId?: string;
  model: string;
  thinkingEnabled?: boolean;
  onMessageSent: () => void;
  onConversationCreated: (id: string) => void;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  onSearchNext?: () => void;
  onSearchPrev?: () => void;
  onForkConversation?: (messages: Message[]) => void;
  onConversationUpdate?: (id: string, updates: Partial<{ title: string }>) => void;
  /** Fired the moment a new chat's stream starts and the backend assigns its id. */
  onConversationStarted?: (id: string) => void;
}

export function ChatView({
  initialMessages, conversationId, model, thinkingEnabled = false, onMessageSent, onConversationCreated,
  searchQuery, onSearchChange, onSearchNext, onSearchPrev, onForkConversation, onConversationUpdate, onConversationStarted,
}: Props) {
  const { messages, isStreaming, sendMessage, regenerate, editMessage, deleteMessage, stopGeneration, conversationId: convId, currentStage, liveDuration } = useChat(
    model, initialMessages, conversationId, thinkingEnabled, 'chat', undefined, onConversationUpdate, false, false, undefined, undefined, undefined, undefined, onConversationStarted
  );

  // Multi-message selection state
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [selectMode, setSelectMode] = useState(false);

  const handleToggleSelect = useCallback((index: number) => {
    setSelectedIndices((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]
    );
  }, []);

  const handleToggleSelectMode = useCallback(() => {
    setSelectMode((prev) => {
      if (prev) setSelectedIndices([]);
      return !prev;
    });
  }, []);

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

  // Track active search match index for navigation
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);

  // Compute search matches across messages
  const searchState = useMemo(() => {
    if (!searchQuery) return { matches: [], activeMatch: 0 };
    const q = searchQuery.toLowerCase();
    const matches: number[] = [];
    messages.forEach((msg, i) => {
      if (msg.role !== 'system' && msg.content.toLowerCase().includes(q)) {
        matches.push(i);
      }
    });
    // Clamp searchMatchIndex to valid range (handles query/messages changes)
    const clampedIndex = Math.min(searchMatchIndex, Math.max(0, matches.length - 1));
    return { matches, activeMatch: clampedIndex };
  }, [searchQuery, messages, searchMatchIndex]);

  const handleSearchNext = useCallback(() => {
    if (searchState.matches.length === 0) return;
    setSearchMatchIndex((prev) => (prev + 1) % searchState.matches.length);
  }, [searchState.matches.length]);

  const handleSearchPrev = useCallback(() => {
    if (searchState.matches.length === 0) return;
    setSearchMatchIndex((prev) => (prev - 1 + searchState.matches.length) % searchState.matches.length);
  }, [searchState.matches.length]);

  const handleFork = useCallback((index: number) => {
    const forkMessages = messages.slice(0, index + 1);
    onForkConversation?.(forkMessages);
  }, [messages, onForkConversation]);

  return (
    <>
      {/* Select mode toggle button */}
      {!isStreaming && messages.length > 0 && (
        <div className="flex items-center justify-end px-4 pt-1 pb-0 gap-2">
          <button
            onClick={handleToggleSelectMode}
            className={`text-xs px-2 py-1 rounded-lg transition-colors ${
              selectMode
                ? 'bg-blue-600/20 text-blue-300 border border-blue-700/40'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
            }`}
          >
            {selectMode ? 'Done selecting' : 'Select messages'}
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
        searchQuery={searchQuery}
        onSearchQueryChange={onSearchChange}
        searchMatches={searchState.matches}
        activeSearchMatch={searchState.activeMatch}
        onSearchNext={handleSearchNext}
        onSearchPrev={handleSearchPrev}
        selectedIndices={selectMode ? selectedIndices : undefined}
        onToggleSelect={selectMode ? handleToggleSelect : undefined}
        selectable={selectMode}
        onFork={selectMode ? undefined : handleFork}
      />
      <InputBar onSend={handleSend} onStop={stopGeneration} isStreaming={isStreaming} draftKey={conversationId ?? 'new'} />
    </>
  );
}
