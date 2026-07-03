import { useChat } from '../hooks/useChat';
import { ChatWindow } from './ChatWindow';
import { InputBar } from './InputBar';
import type { Message } from '../types';

interface Props {
  initialMessages: Message[];
  model: string;
  onMessageSent: () => void;
  onConversationCreated: (id: string) => void;
}

export function ChatView({ initialMessages, model, onMessageSent, onConversationCreated }: Props) {
  const { messages, isStreaming, sendMessage, stopGeneration } = useChat(model, initialMessages);

  const handleSend = async (content: string) => {
    const newId = await sendMessage(content);
    if (newId) onConversationCreated(newId);
    onMessageSent();
  };

  return (
    <>
      <ChatWindow messages={messages} isStreaming={isStreaming} />
      <InputBar onSend={handleSend} onStop={stopGeneration} isStreaming={isStreaming} />
    </>
  );
}
