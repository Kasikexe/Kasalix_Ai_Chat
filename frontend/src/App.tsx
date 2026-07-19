import { useEffect, useMemo, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { ChatView } from './components/ChatView';
import { AgentWorkspace } from './components/AgentWorkspace';
import { VideoEditor } from './components/VideoEditor';
import { ModelAssignmentModal } from './components/ModelAssignmentModal';
import { UserSettingsModal } from './components/UserSettingsModal';
import { PasswordPrompt } from './components/PasswordPrompt';
import { UserSetup } from './components/UserSetup';
import { useModelAssignments } from './hooks/useModelAssignments';
import { useConversations } from './hooks/useConversations';
import { useModelVisibility } from './hooks/useModelVisibility';
import { useIsMobile } from './hooks/useIsMobile';
import { useTheme } from './hooks/useTheme';
import { useMemory } from './hooks/useMemory';
import {
  api,
  getUserProfile,
  createUserProfile,
  updateUserProfile,
  clearUserProfile,
} from './services/api';
import type { ConversationMode, UserProfile, OllamaModel } from './types';

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
    isAuthed, authenticate,
  } = useModelVisibility();
  const {
    assignments: modelAssignments,
    loading: assignmentsLoading,
    getChatModel,
    saveAll: saveModelAssignments,
  } = useModelAssignments();
  const { theme, toggleTheme } = useTheme();
  const {
    memory,
    toggleMemory,
    addEntry: addMemoryEntry,
    editEntry: editMemoryEntry,
    removeEntry: removeMemoryEntry,
    addCategory: addMemoryCategory,
    removeCategory: removeMemoryCategory,
    resetMemory,
    refresh: refreshMemory,
  } = useMemory();
  const { conversations, create, remove, rename, refresh } = useConversations();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modelAssignOpen, setModelAssignOpen] = useState(false);
  const [userSettingsOpen, setUserSettingsOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [mode, setMode] = useState<ConversationMode>('chat');

  // Derive the main chat model from assignments + thinking toggle
  const model = assignmentsLoading ? (thinkingEnabled ? 'qwen3:4b' : 'qwen2.5:3b') : getChatModel(thinkingEnabled);
  // Fetch all installed models for the assignment modal
  const [allModels, setAllModels] = useState<OllamaModel[]>([]);
  useEffect(() => {
    api.getModels().then(setAllModels).catch(() => {});
  }, []);

  // Web search toggle
  const SEARCH_KEY = 'ai-chat:searchEnabled';
  const [searchEnabled, setSearchEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem(SEARCH_KEY) === 'true'; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(SEARCH_KEY, String(searchEnabled)); } catch {}
  }, [searchEnabled]);

  const [localUser, setLocalUser] = useState(user);

  useEffect(() => {
    setLocalUser(user);
  }, [user]);
  const isMobile = useIsMobile();

  const activeConv = useMemo(
    () => (activeId ? conversations.find((c) => c.id === activeId) ?? null : null),
    [activeId, conversations]
  );

  const handleAdminClick = () => {
    if (isAuthed) setModelAssignOpen(true);
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
    // Prevent switching to Agent/Editor on mobile
    if (isMobile && (newMode === 'agent' || newMode === 'editor')) return;
    setMode(newMode);
    setActiveId(null);
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
        user={localUser}
        onSwitchUser={onSwitchUser}
        onUserSettings={() => setUserSettingsOpen(true)}
        mode={mode}
        onModeChange={handleModeChange}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <Header
          onMenuClick={() => setSidebarOpen(true)}
          onAdminClick={handleAdminClick}
          isAdmin={isAuthed}
          thinkingEnabled={thinkingEnabled}
          onToggleThinking={onToggleThinking}
          searchEnabled={searchEnabled}
          onToggleSearch={() => setSearchEnabled(s => !s)}
          conversation={activeConv}
        />
        {mode === 'agent' ? (
          <AgentWorkspace
            key={activeConv?.id || 'new'}
            conversation={activeConv}
            onCreateNew={handleNewChat}
            model={model}
            thinkingEnabled={thinkingEnabled}
            onMessageSent={() => { refresh(); refreshMemory(); }}
            onConversationCreated={setActiveId}
          />
        ) : mode === 'editor' ? (
          <VideoEditor
            key={activeConv?.id || 'new'}
            conversation={activeConv}
            onNewVideoProject={async (title: string, workspacePath: string) => {
              const conv = await create(model, title, 'editor', workspacePath);
              setActiveId(conv.id);
              setSidebarOpen(false);
              return conv;
            }}
          />
        ) : (
          <ChatView
            key={activeConv?.id || 'new'}
            initialMessages={activeConv?.messages || []}
            conversationId={activeConv?.id}
            model={model}
            thinkingEnabled={thinkingEnabled}
            searchEnabled={searchEnabled}
            onMessageSent={() => { refresh(); refreshMemory(); }}
            onConversationCreated={setActiveId}
          />
        )}
      </div>

      <UserSettingsModal
        open={userSettingsOpen}
        onClose={() => setUserSettingsOpen(false)}
        profile={localUser}
        onUpdate={(updates) => {
          const updated = updateUserProfile(updates);
          setLocalUser(updated);
          return updated;
        }}
        onSwitch={onSwitchUser}
        thinkingEnabled={thinkingEnabled}
        onToggleThinking={onToggleThinking}
        theme={theme}
        onToggleTheme={toggleTheme}
        memoryEnabled={memory.enabled}
        memoryCategories={memory.categories}
        onToggleMemory={toggleMemory}
        onAddMemoryEntry={addMemoryEntry}
        onEditMemoryEntry={editMemoryEntry}
        onRemoveMemoryEntry={removeMemoryEntry}
        onAddMemoryCategory={addMemoryCategory}
        onRemoveMemoryCategory={removeMemoryCategory}
        onResetMemory={resetMemory}
        onRefreshMemory={refreshMemory}
      />

      <ModelAssignmentModal
        open={modelAssignOpen}
        onClose={() => setModelAssignOpen(false)}
        models={allModels}
        assignments={modelAssignments}
        onSave={saveModelAssignments}
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
