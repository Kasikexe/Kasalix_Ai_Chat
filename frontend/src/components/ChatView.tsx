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
}

export function ChatView({
  initialMessages, conversationId, model, thinkingEnabled = false, onMessageSent, onConversationCreated,
}: Props) {
  const { messages, isStreaming, sendMessage, regenerate, editMessage, stopGeneration, currentStage } = useChat(
    model, initialMessages, conversationId, thinkingEnabled, 'chat', undefined
  );

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

  return (
    <>
      <ChatWindow
        messages={messages}
        isStreaming={isStreaming}
        currentStage={currentStage}
        onEdit={handleEdit}
        onRegenerate={handleRegenerate}
      />
      <InputBar onSend={handleSend} onStop={stopGeneration} isStreaming={isStreaming} />
    </>
  );
}
