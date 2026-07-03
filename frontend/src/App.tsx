import { useEffect, useMemo, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { ChatView } from './components/ChatView';
import { SettingsModal } from './components/SettingsModal';
import { PasswordPrompt } from './components/PasswordPrompt';
import { StatusBanner } from './components/StatusBanner';
import { UserSetup } from './components/UserSetup';
import { useConversations } from './hooks/useConversations';
import { useModel } from './hooks/useModel';
import { useModelVisibility } from './hooks/useModelVisibility';
import {
  getUserProfile,
  createUserProfile,
  clearUserProfile,
} from './services/api';
import type { UserProfile } from './types';

function App() {
  const [user, setUser] = useState<UserProfile | null>(() => {
    const stored = getUserProfile();
    console.log('App: Initial user from localStorage:', stored);
    return stored;
  });

  if (!user) {
    return (
      <UserSetup
        onSubmit={(name) => {
          console.log('App: onSubmit called with name:', name);
          try {
            const profile = createUserProfile(name);
            console.log('App: profile created:', profile);
            setUser(profile);
            console.log('App: setUser called');
          } catch (e) {
            console.error('App: Error in onSubmit:', e);
            alert('Error: ' + (e instanceof Error ? e.message : String(e)));
          }
        }}
      />
    );
  }

  return (
    <ChatApp
      user={user}
      onSwitchUser={() => {
        console.log('App: Switching user');
        clearUserProfile();
        setUser(null);
      }}
    />
  );
}


interface ChatAppProps {
  user: UserProfile;
  onSwitchUser: () => void;
}

function ChatApp({ user, onSwitchUser }: ChatAppProps) {
  const {
    models, selectedModel, setSelectedModel,
    loading: modelsLoading, error: modelError, online, getModelStatus,
  } = useModel();
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
    if (!selectedModel) return;
    const conv = await create(selectedModel);
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

  const renderMain = () => {
    if (modelsLoading) {
      return (
        <div className="flex-1 flex items-center justify-center text-gray-400">
          Loading models...
        </div>
      );
    }

    if (modelError && models.length === 0) {
      return (
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="text-center max-w-md">
            <h2 className="text-xl font-semibold mb-2 text-white">Connection Error</h2>
            <p className="text-gray-400 mb-4">{modelError}</p>
            <p className="text-gray-500 text-sm">
              Make sure Ollama is running: <code className="text-emerald-400">ollama serve</code>
            </p>
          </div>
        </div>
      );
    }

    return (
      <ChatView
        key={activeConv?.id || 'new'}
        initialMessages={activeConv?.messages || []}
        model={selectedModel}
        onMessageSent={refresh}
        onConversationCreated={setActiveId}
      />
    );
  };

  return (
    <div className="h-screen flex bg-gray-950 text-white overflow-hidden">
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
          models={models}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          onMenuClick={() => setSidebarOpen(true)}
          onSettingsClick={handleSettingsClick}
          isAdmin={isAuthed}
          getModelStatus={getModelStatus}
        />
        <StatusBanner online={online} models={models} />
        {renderMain()}
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        models={models}
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
