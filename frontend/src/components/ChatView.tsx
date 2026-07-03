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
  const { messages, isStreaming, sendMessage, stopGeneration, currentStage } = useChat(
    model, initialMessages, conversationId, thinkingEnabled
  );

  const handleSend = async (content: string) => {
    const newId = await sendMessage(content);
    if (newId) onConversationCreated(newId);
    onMessageSent();
  };

  return (
    <>
      <ChatWindow
        messages={messages}
        isStreaming={isStreaming}
        currentStage={currentStage}
      />
      <InputBar onSend={handleSend} onStop={stopGeneration} isStreaming={isStreaming} />
    </>
  );
}
