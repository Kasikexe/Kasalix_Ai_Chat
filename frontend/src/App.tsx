import { useEffect, useMemo, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { ChatView } from './components/ChatView';
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
import type { UserProfile } from './types';

const TEXT_MODEL = 'qwen3:4b';
const THINKING_KEY = 'ai-chat:thinkingEnabled';

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
    />
  );
}

interface ChatAppProps {
  user: UserProfile;
  onSwitchUser: () => void;
  thinkingEnabled: boolean;
  onToggleThinking: () => void;
}

function ChatApp({ user, onSwitchUser, thinkingEnabled, onToggleThinking }: ChatAppProps) {
  const {
    isHidden, toggle, showAll, hideAll, reset, isAuthed, authenticate,
  } = useModelVisibility();
  const { conversations, create, remove, rename, refresh } = useConversations();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const activeConv = useMemo(
    () => (activeId ? conversations.find((c) => c.id === activeId) : null),
    [activeId, conversations]
  );

  const handleSettingsClick = () => {
    if (isAuthed) setSettingsOpen(true);
    else setPasswordOpen(true);
  };

  const handleNewChat = async () => {
    const conv = await create(TEXT_MODEL);
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
      />
      <div className="flex-1 flex flex-col min-w-0">
        <Header
          onMenuClick={() => setSidebarOpen(true)}
          onSettingsClick={handleSettingsClick}
          isAdmin={isAuthed}
          thinkingEnabled={thinkingEnabled}
          onToggleThinking={onToggleThinking}
        />
        <ChatView
          key={activeConv?.id || 'new'}
          initialMessages={activeConv?.messages || []}
          conversationId={activeConv?.id}
          model={TEXT_MODEL}
          thinkingEnabled={thinkingEnabled}
          onMessageSent={refresh}
          onConversationCreated={setActiveId}
        />
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
