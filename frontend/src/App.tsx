import { useEffect, useMemo, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { ChatView } from './components/ChatView';
import { AgentWorkspace } from './components/AgentWorkspace';
import { SettingsModal } from './components/SettingsModal';
import { PasswordPrompt } from './components/PasswordPrompt';
import { UserSetup } from './components/UserSetup';
import { useConversations } from './hooks/useConversations';
import { useModelVisibility } from './hooks/useModelVisibility';
import {
  getUserProfile,
  createUserProfile,
  clearUserProfile,
} from './services/api';
import type { ConversationMode, UserProfile } from './types';

const THINKING_KEY = 'ai-chat:thinkingEnabled';

function getModel(thinkingEnabled: boolean): string {
  return thinkingEnabled ? 'qwen3:4b' : 'qwen2.5:3b';
}

function App() {
  const [user, setUser] = useState<UserProfile | null>(() => getUserProfile());
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(() => {
    const stored = localStorage.getItem(THINKING_KEY);
    return stored === 'true'; // default OFF for speed
  });

  // Persist thinking preference
  useEffect(() => {
    localStorage.setItem(THINKING_KEY, String(thinkingEnabled));
  }, [thinkingEnabled]);

  if (!user) {
    return (
      <UserSetup
        onSubmit={(name) => {
          const profile = createUserProfile(name);
          setUser(profile);
        }}
      />
    );
  }

  return (
    <ChatApp
      user={user}
      onSwitchUser={() => {
        clearUserProfile();
        setUser(null);
      }}
      thinkingEnabled={thinkingEnabled}
      onToggleThinking={() => setThinkingEnabled(t => !t)}
      model={getModel(thinkingEnabled)}
    />
  );
}

interface ChatAppProps {
  user: UserProfile;
  onSwitchUser: () => void;
  thinkingEnabled: boolean;
  onToggleThinking: () => void;
  model: string;
}

function ChatApp({ user, onSwitchUser, thinkingEnabled, onToggleThinking, model }: ChatAppProps) {
  const {
    isHidden, toggle, showAll, hideAll, reset, isAuthed, authenticate,
  } = useModelVisibility();
  const { conversations, create, remove, rename, refresh } = useConversations();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [mode, setMode] = useState<ConversationMode>('chat');

  const activeConv = useMemo(
    () => (activeId ? conversations.find((c) => c.id === activeId) ?? null : null),
    [activeId, conversations]
  );

  const handleSettingsClick = () => {
    if (isAuthed) setSettingsOpen(true);
    else setPasswordOpen(true);
  };

  const handleNewChat = async () => {
    const conv = await create(model, undefined, mode);
    setActiveId(conv.id);
    setSidebarOpen(false);
  };

  const handleSelect = (id: string) => {
    setActiveId(id);
    setSidebarOpen(false);
  };

  const handleDelete = async (id: string) => {
    await remove(id);
    if (activeId === id) setActiveId(null);
  };

  const handleModeChange = (newMode: ConversationMode) => {
    setMode(newMode);
    setActiveId(null);
  };

  const isAgent = mode === 'agent';

  return (
    <div className="h-screen-dynamic flex bg-gray-950 text-white overflow-hidden">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelect}
        onCreate={handleNewChat}
        onDelete={handleDelete}
        onRename={rename}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        user={user}
        onSwitchUser={onSwitchUser}
        mode={mode}
        onModeChange={handleModeChange}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <Header
          onMenuClick={() => setSidebarOpen(true)}
          onSettingsClick={handleSettingsClick}
          isAdmin={isAuthed}
          thinkingEnabled={thinkingEnabled}
          onToggleThinking={onToggleThinking}
          conversation={activeConv}
        />
        {isAgent ? (
          <AgentWorkspace
            key={activeConv?.id || 'new'}
            conversation={activeConv}
            onCreateNew={handleNewChat}
            model={model}
            thinkingEnabled={thinkingEnabled}
            onMessageSent={refresh}
            onConversationCreated={setActiveId}
          />
        ) : (
          <ChatView
            key={activeConv?.id || 'new'}
            initialMessages={activeConv?.messages || []}
            conversationId={activeConv?.id}
            model={model}
            thinkingEnabled={thinkingEnabled}
            onMessageSent={refresh}
            onConversationCreated={setActiveId}
          />
        )}
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        models={[]}
        isHidden={isHidden}
        onToggle={toggle}
        onShowAll={showAll}
        onHideAll={hideAll}
        onReset={reset}
      />

      <PasswordPrompt
        open={passwordOpen}
        onClose={() => setPasswordOpen(false)}
        onSubmit={authenticate}
      />
    </div>
  );
}

export default App;
