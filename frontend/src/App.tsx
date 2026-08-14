import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { ChatView } from './components/ChatView';
import { AgentWorkspace } from './components/AgentWorkspace';
import { ServerConnect } from './components/ServerConnect';
import { ServerConfig } from './components/ServerConfig';
import { ServerDownOverlay } from './components/ServerDownOverlay';
import { UserSettingsModal } from './components/UserSettingsModal';
import { UpdateBanner } from './components/UpdateBanner';
import { UserSetup } from './components/UserSetup';
import { ToastProvider } from './hooks/useToast';
import { useModelAssignments } from './hooks/useModelAssignments';
import { useConversations } from './hooks/useConversations';
import { discardLiveConversation } from './hooks/useChat';
import { useIsMobile } from './hooks/useIsMobile';
import { useTheme } from './hooks/useTheme';
import { useMemory } from './hooks/useMemory';
import {
  api,
  getUserProfile,
  createUserProfile,
  updateUserProfile,
  clearUserProfile,
  isLoggedIn,
} from './services/api';
import type { ConversationMode, UserProfile } from './types';

const THINKING_KEY = 'ai-chat:thinkingEnabled';

function App() {
  const [user, setUser] = useState<UserProfile | null>(() => getUserProfile());
  const [serverConnected, setServerConnected] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);
  // Thinking is AUTO by default (adaptive): the backend decides per message
  // whether reasoning is needed. Switching it off disables thinking entirely.
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(() => {
    const stored = localStorage.getItem(THINKING_KEY);
    return stored !== 'false';
  });

  // Persist thinking preference
  useEffect(() => {
    localStorage.setItem(THINKING_KEY, String(thinkingEnabled));
  }, [thinkingEnabled]);

  // Check for existing session on startup
  useEffect(() => {
    (async () => {
      if (isLoggedIn()) {
        const result = await api.checkSession();
        if (result.authenticated && result.user) {
          setUser(result.user);
        } else {
          // Session expired or invalid — user will need to login
          setUser(null);
        }
      } else {
        setUser(null);
      }
      setSessionChecked(true);
    })();
  }, []);

  if (!sessionChecked) {
    // Show a loading state while checking session
    return (
      <div style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#030712',
        color: 'white',
        fontSize: '14px',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '24px', marginBottom: '12px' }}>🤖</div>
          <div style={{ color: '#9ca3af' }}>Checking session...</div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <UserSetup
        onSubmit={(name) => {
          // Profile is already saved by api.register()/api.login() — just load it
          const existing = getUserProfile();
          if (existing) {
            setUser(existing);
          } else {
            const profile = createUserProfile(name);
            setUser(profile);
          }
        }}
      />
    );
  }

  if (!serverConnected) {
    return <ServerConnect onConnected={() => setServerConnected(true)} />;
  }

  return (
    <ToastProvider>
      <ChatApp
        user={user}
        onSwitchUser={async () => {
          await api.logout();
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
  const [serverConfigOpen, setServerConfigOpen] = useState(false);
  const {
    loading: assignmentsLoading,
    getChatModel,
    getThinkingModel,
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
  const [userSettingsOpen, setUserSettingsOpen] = useState(false);
  const [mode, setMode] = useState<ConversationMode>('chat');
  const [viewTab, setViewTab] = useState<'chat' | 'agent'>('chat');
  const [offlineWorkspace, setOfflineWorkspace] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActive, setSearchActive] = useState(false);
  // Installed models -> whether they support thinking (from the backend).
  const [modelSupport, setModelSupport] = useState<Record<string, boolean>>({});

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

  // Load thinking capability once from the backend's model list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.getModels();
        if (cancelled) return;
        const map: Record<string, boolean> = {};
        for (const m of list) map[m.name] = m.supportsThinking !== false;
        setModelSupport(map);
      } catch {
        // Server offline — unknown models default to supported below.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Unknown / not-yet-installed models default to supported so the toggle
  // doesn't vanish for a transient state.
  const chatModel = assignmentsLoading ? 'qwen3:4b' : getChatModel();
  const thinkingChatModel = assignmentsLoading ? 'qwen3:4b' : getThinkingModel();
  const chatSupportsThinking = modelSupport[chatModel] !== false;
  const thinkingModelSupportsThinking = modelSupport[thinkingChatModel] !== false;

  // The client always sends the base chat model. In auto mode the backend
  // decides per message whether to think, and routes to the dedicated
  // Chat (Thinking) model when the base model can't think.
  const model = chatModel;
  // The toggle is only useful when thinking is possible via one of the two models.
  const thinkingSupported = chatSupportsThinking || thinkingModelSupportsThinking;

  // Web search is always enabled (no toggle needed)

  const isMobile = useIsMobile();

  const activeConv = useMemo(
    () => (activeId ? conversations.find((c) => c.id === activeId) ?? null : null),
    [activeId, conversations]
  );

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
    discardLiveConversation(id);
    if (activeId === id) setActiveId(null);
  };

  // A brand-new chat becomes real server-side the moment its first stream
  // starts (the backend assigns the id as the very first SSE event). Register
  // it in the sidebar right away so the user can switch back to it mid-answer
  // and still see the live progress.
  const handleConversationStarted = useCallback((id: string) => {
    api.getConversation(id).then((conv) => update(conv)).catch(() => {});
    // If we're still on the fresh (unsaved) chat, adopt the real id so the
    // view re-attaches to the live stream instead of losing it.
    setActiveId((cur) => cur ?? id);
  }, [update]);

  // Never yank the user back to a conversation whose stream finished while
  // they were browsing another chat — only adopt the id if they're still on
  // the fresh view.
  const handleConversationCreated = useCallback((id: string) => {
    setActiveId((cur) => cur ?? id);
  }, []);

  const handleModeChange = (newMode: ConversationMode) => {
    // Agent mode is only available in the desktop app
    const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI?.isElectron;
    if (!isElectron && newMode === 'agent') return;
    setMode(newMode);
    setViewTab(newMode);
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
          thinkingEnabled={thinkingEnabled}
          onToggleThinking={onToggleThinking}
          thinkingSupported={thinkingSupported}
          conversation={activeConv}
          onConfigureServer={() => setServerConfigOpen(true)}
        />
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
          {/* Smooth mode transition wrapper */}
          <div
            key={viewTab}
            className="flex-1 flex flex-col min-h-0 animate-mode-fade-in"
          >
            {mode === 'agent' ? (
              <AgentWorkspace
                key={activeConv?.id || 'new'}
                conversation={activeConv}
                offlineWorkspace={offlineWorkspace}
                onCreateNew={handleNewChat}                model={model}
                thinkingEnabled={thinkingEnabled}
                onMessageSent={() => { refresh(); refreshMemory(); }}
                onConversationCreated={handleConversationCreated}
                onConversationStarted={handleConversationStarted}
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
            ) : (
                  <ChatView
                    key={activeConv?.id || 'new'}
                    initialMessages={activeConv?.messages || []}
                    conversationId={activeConv?.id}
                    model={model}
                thinkingEnabled={thinkingEnabled}
                onMessageSent={() => { refresh(); refreshMemory(); }}
                onConversationCreated={handleConversationCreated}
                onConversationStarted={handleConversationStarted}
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
        thinkingSupported={thinkingSupported}
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

      {/* Update notification banner — shows in Electron when new version is available */}
      <UpdateBanner />

      {/* Server configuration modal — lets the user change the backend address when the app can't reach it */}
      {serverConfigOpen && (
        <ServerConfig
          onSaved={() => { window.location.reload(); }}
          showClose
          onClose={() => setServerConfigOpen(false)}
        />
      )}

      {/* Server down overlay — shows only when running in Electron and server is offline */}
      <ServerDownOverlay
        isElectron={!!(window as any).electronAPI?.isElectron}
        onConfigure={() => setServerConfigOpen(true)}
        onBrowseFolder={async () => {
          try {
            const result = await (window as any).electronAPI.openFolderDialog();
            if (!result.canceled && result.path) {
              setOfflineWorkspace(result.path);
              handleModeChange('agent');
            }
          } catch (e) {
            console.error('Browse folder failed:', e);
          }
        }}
      />

    </div>
  );
}

export default App;
