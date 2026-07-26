import { useEffect, useMemo, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { ChatView } from './components/ChatView';
import { AgentWorkspace } from './components/AgentWorkspace';
import { VideoEditor } from './components/VideoEditor';
import { ServerDownOverlay } from './components/ServerDownOverlay';
import { ModelAssignmentModal } from './components/ModelAssignmentModal';
import { UserSettingsModal } from './components/UserSettingsModal';
import { PasswordPrompt } from './components/PasswordPrompt';
import { UserSetup } from './components/UserSetup';
import { ToastProvider } from './hooks/useToast';
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
    <ToastProvider>
      <ChatApp
        user={user}
        onSwitchUser={() => {
          clearUserProfile();
          setUser(null);
        }}
        thinkingEnabled={thinkingEnabled}
        onToggleThinking={() => setThinkingEnabled(t => !t)}
      />
    </ToastProvider>
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
  const { conversations, loading: conversationsLoading, create, remove, rename, update, refresh } = useConversations();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modelAssignOpen, setModelAssignOpen] = useState(false);
  const [userSettingsOpen, setUserSettingsOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [mode, setMode] = useState<ConversationMode>('chat');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActive, setSearchActive] = useState(false);

  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    if (query) setSearchActive(true);
  };

  const handleSearchClose = () => {
    setSearchActive(false);
    setSearchQuery('');
  };

  const [localUser, setLocalUser] = useState(user);

  useEffect(() => {
    setLocalUser(user);
  }, [user]);

  // Derive the main chat model from assignments + thinking toggle
  const model = assignmentsLoading ? (thinkingEnabled ? 'qwen3:4b' : 'qwen2.5:3b') : getChatModel(thinkingEnabled);

  // Fetch all installed models for the assignment modal and model selector
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

  const isMobile = useIsMobile();

  const activeConv = useMemo(
    () => (activeId ? conversations.find((c) => c.id === activeId) ?? null : null),
    [activeId, conversations]
  );

  const handleAdminClick = () => {
    if (isAuthed) setModelAssignOpen(true);
    else setPasswordOpen(true);
  };

  // Wrap authenticate to auto-open the model modal after successful login
  const handleAuthenticate = async (password: string): Promise<boolean> => {
    const ok = await authenticate(password);
    if (ok) {
      setPasswordOpen(false);
      setModelAssignOpen(true);
    }
    return ok;
  };

  // Refresh conversations when the window regains focus (helps Electron on startup)
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // On mount in Electron: auto-detect the backend server on the network
  useEffect(() => {
    (async () => {
      const isElectron = !!(window as any).electronAPI?.isElectron;
      if (!isElectron) return;

      try {
        // Check if we already have a saved config
        const current = await (window as any).electronAPI.getBackendUrl();
        if (current?.hasSavedConfig) return; // Already configured

        // Auto-scan the subnet for the backend server
        const scanResult = await (window as any).electronAPI.scanSubnet();
        if (scanResult?.found && scanResult?.url) {
          // Save it automatically — no user interaction needed
          await (window as any).electronAPI.setBackendUrl(scanResult.url);
          // Reload so the proxy uses the new URL
          window.location.reload();
        }
      } catch (err) {
        console.warn('[App] Auto-detect failed:', err);
      }
    })();
  }, []);

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
    // Agent & Editor modes are only available in the desktop app
    const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI?.isElectron;
    if (!isElectron && (newMode === 'agent' || newMode === 'editor')) return;
    setMode(newMode);
    setActiveId(null);
  };

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore when typing in inputs
      const isInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      
      // Ctrl+N: New conversation
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        handleNewChat();
        return;
      }
      // Ctrl+Shift+Delete: Delete current conversation
      if (e.ctrlKey && e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        if (activeId) handleDelete(activeId);
        return;
      }
      // Ctrl+F: Search messages
      if (e.ctrlKey && e.key === 'f' && mode === 'chat') {
        e.preventDefault();
        setSearchActive((prev) => !prev);
        if (searchActive) setSearchQuery('');
        return;
      }
      // Escape: Close search
      if (e.key === 'Escape' && searchActive) {
        handleSearchClose();
        return;
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeId, searchActive, mode]);

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
        loading={conversationsLoading}
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
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
          {/* Smooth mode transition wrapper */}
          <div
            key={mode}
            className="flex-1 flex flex-col min-h-0 animate-mode-fade-in"
          >
            {mode === 'agent' ? (
              <AgentWorkspace
                key={activeConv?.id || 'new'}
                conversation={activeConv}
                onCreateNew={handleNewChat}                model={model}
                thinkingEnabled={thinkingEnabled}
                onMessageSent={() => { refresh(); refreshMemory(); }}
                onConversationCreated={setActiveId}
                onForkConversation={async (forkMessages) => {
                  const conv = await create(model, undefined, 'agent');
                  for (const msg of forkMessages) {
                    await api.addConversationMessage(conv.id, msg.role as 'user' | 'assistant', msg.content);
                  }
                  try {
                    const updatedConv = await api.getConversation(conv.id);
                    update(updatedConv);
                    setActiveId(updatedConv.id);
                    refresh();
                  } catch {
                    setActiveId(conv.id);
                  }
                  setSidebarOpen(false);
                }}
              />
            ) : mode === 'editor'
                ? (
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
                )
                : (
                  <ChatView
                    key={activeConv?.id || 'new'}
                    initialMessages={activeConv?.messages || []}
                    conversationId={activeConv?.id}
                    model={model}
                thinkingEnabled={thinkingEnabled}
                searchEnabled={searchEnabled}
                onMessageSent={() => { refresh(); refreshMemory(); }}
                onConversationCreated={setActiveId}
                searchQuery={searchActive ? searchQuery : undefined}
                onSearchChange={handleSearchChange}
                onConversationUpdate={(id, updates) => {
                  // Update local state immediately without waiting for API refresh
                  api.getConversation(id).then((conv) => update(conv)).catch(() => {});
                }}
                onForkConversation={async (forkMessages) => {
                  const conv = await create(model, undefined, 'chat');
                  // Add the forked messages to the new conversation
                  for (const msg of forkMessages) {
                    await api.addConversationMessage(conv.id, msg.role as 'user' | 'assistant', msg.content);
                  }
                  // Fetch the full conversation data so ChatView mounts with all messages
                  try {
                    const updatedConv = await api.getConversation(conv.id);
                    update(updatedConv);
                    setActiveId(updatedConv.id);
                    // Force refresh sidebar immediately
                    refresh();
                  } catch {
                    setActiveId(conv.id);
                  }
                  setSidebarOpen(false);
                }}
              />
            )}
          </div>
        </div>
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

      {/* Server down overlay — shows only when running in Electron and server is offline */}
      <ServerDownOverlay
        isElectron={!!(window as any).electronAPI?.isElectron}
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
        onSubmit={handleAuthenticate}
      />
    </div>
  );
}

export default App;
