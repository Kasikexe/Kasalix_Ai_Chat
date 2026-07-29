import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Plus, Trash2, Edit2, X, Check, Menu, Wrench, Search, Film, FolderOpen, ChevronDown, ChevronRight, AlertTriangle, Clock, ListChecks } from 'lucide-react';
import type { Conversation, ConversationMode } from '../types';
import type { UserProfile } from '../types';
import { UserBadge } from './UserBadge';
import { useIsMobile } from '../hooks/useIsMobile';
import { useToast } from '../hooks/useToast';
import { ConversationSkeleton } from './Skeleton';

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  isOpen: boolean;
  onClose: () => void;
  user: UserProfile;
  onSwitchUser: () => void;
  onUserSettings?: () => void;
  mode: ConversationMode;
  onModeChange: (mode: ConversationMode | 'logs' | 'planned') => void;
  loading?: boolean;
}

// Generate a consistent avatar color from a string
function getAvatarColor(str: string): string {
  const colors = ['#3b82f6', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#14b8a6', '#a855f7'];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

function getInitials(title: string): string {
  if (!title) return '?';
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return title.slice(0, 2).toUpperCase();
}

export function Sidebar({
  conversations, activeId, onSelect, onCreate, onDelete, onRename,
  isOpen, onClose, user, onSwitchUser, onUserSettings, mode, onModeChange, loading = false,
}: SidebarProps) {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  // Agent & Editor modes are disabled on the web — only available in the desktop app
  const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI?.isElectron;
  const isWebBlocked = !isElectron;

  // Extract project name from workspace path
  const getProjectName = (wsPath?: string): string => {
    if (!wsPath) return 'Other';
    const parts = wsPath.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] || 'Other';
  };

  // Track whether auto-expand has already happened (to avoid stale dep warnings)
  const hasAutoExpanded = useRef(false);

  // Auto-expand the most recent project group when first entering agent mode
  useEffect(() => {
    if (mode === 'agent' && !hasAutoExpanded.current) {
      const agentConvs = conversations.filter((c) => (c.mode || 'chat') === 'agent');
      if (agentConvs.length > 0) {
        // Find the most recent project
        const groups = new Map<string, typeof agentConvs>();
        for (const conv of agentConvs) {
          const project = conv.workspacePath ? getProjectName(conv.workspacePath) : 'Other';
          if (!groups.has(project)) groups.set(project, []);
          groups.get(project)!.push(conv);
        }
        let topProject = '';
        let topTime = 0;
        for (const [proj, convs] of groups) {
          const latest = Math.max(...convs.map((c) => c.updatedAt));
          if (latest > topTime) { topTime = latest; topProject = proj; }
        }
        if (topProject) {
          setExpandedProjects(new Set([topProject]));
          hasAutoExpanded.current = true;
        }
      }
    }
  }, [mode, conversations]);

  // Toggle project group expansion
  const toggleProject = (project: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  };

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const startEdit = (conv: Conversation) => {
    setEditingId(conv.id);
    setEditValue(conv.title);
  };

  const commitEdit = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim());
    }
    setEditingId(null);
    setEditValue('');
  };

  // Find the first message content that matches the search query
  const findMessageMatch = (conv: Conversation, query: string): { role: string; snippet: string } | null => {
    const lower = query.toLowerCase();
    for (const msg of conv.messages) {
      const idx = msg.content.toLowerCase().indexOf(lower);
      if (idx !== -1) {
        // Extract a snippet around the match
        const start = Math.max(0, idx - 40);
        const end = Math.min(msg.content.length, idx + query.length + 60);
        let snippet = msg.content.slice(start, end);
        // Clean up image markers from snippets
        snippet = snippet.replace(/\[image:data:image\/[^\]]+\]/g, '[image]');
        if (start > 0) snippet = '...' + snippet;
        if (end < msg.content.length) snippet = snippet + '...';
        return { role: msg.role === 'user' ? 'You' : 'AI', snippet };
      }
    }
    return null;
  };

  // Count total matches across all messages
  const countMatches = (conv: Conversation, query: string): number => {
    const lower = query.toLowerCase();
    let count = 0;
    for (const msg of conv.messages) {
      let idx = 0;
      const content = msg.content.toLowerCase();
      while ((idx = content.indexOf(lower, idx)) !== -1) {
        count++;
        idx += query.length;
      }
    }
    return count;
  };

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 bg-black/60 z-30 md:hidden backdrop-blur-sm" onClick={onClose} />
      )}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-40 w-72 bg-gray-900 text-white transform transition-transform duration-300 flex flex-col border-r border-gray-800 ${
          isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        <div className="p-3 flex items-center justify-between border-b border-gray-800">
          <h1 className="text-base font-semibold flex items-center gap-2">
            <Menu size={18} className="md:hidden" />
            Kasalix AI Chat
          </h1>
          <button
            onClick={onClose}
            className="md:hidden p-1.5 hover:bg-gray-800 rounded"
            aria-label="Close sidebar"
          >
            <X size={18} />
          </button>
        </div>

        {/* Mode toggle */}
        <div className="mx-3 mt-3 flex bg-gray-800 rounded-lg p-0.5 border border-gray-700">
          <button
            onClick={() => onModeChange('chat')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              mode === 'chat'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <MessageSquare size={14} />
            Chat
          </button>
          <button
            onClick={() => !isWebBlocked && onModeChange('agent')}
            disabled={isWebBlocked}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all relative ${
              mode === 'agent'
                ? 'bg-purple-600 text-white shadow-sm'
                : isWebBlocked
                  ? 'text-gray-600 cursor-not-allowed opacity-50'
                  : 'text-gray-400 hover:text-gray-200'
            }`}
            title={isWebBlocked ? 'Available in the desktop app — download below' : 'Agent mode'}
          >
            <Wrench size={14} />
            Agent
            <span className="absolute -top-1.5 -right-1.5 px-1 py-0.5 text-[8px] font-bold bg-amber-500 text-black rounded-sm leading-none shadow-sm">
              BETA
            </span>
          </button>
          <button
            onClick={() => !isWebBlocked && onModeChange('editor')}
            disabled={isWebBlocked}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all relative ${
              mode === 'editor'
                ? 'bg-red-600 text-white shadow-sm'
                : isWebBlocked
                  ? 'text-gray-600 cursor-not-allowed opacity-50'
                  : 'text-gray-400 hover:text-gray-200'
            }`}
            title={isWebBlocked ? 'Available in the desktop app — download below' : 'Editor mode'}
          >
            <Film size={14} />
            Editor
            <span className="absolute -top-1.5 -right-1.5 px-1 py-0.5 text-[8px] font-bold bg-amber-500 text-black rounded-sm leading-none shadow-sm">
              BETA
            </span>
          </button>
        </div>

        {/* Logs & Planned buttons below mode tabs */}
        <div className="mx-3 mt-2 flex gap-1">
          <button
            onClick={() => onModeChange('logs')}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700 border border-gray-700"
            title="View activity log"
          >
            <Clock size={13} />
            Logs
          </button>
          <button
            onClick={() => onModeChange('planned')}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700 border border-gray-700"
            title="View planned features"
          >
            <ListChecks size={13} />
            Planned
          </button>
        </div>

        <button
          onClick={onCreate}
          className="mx-3 mt-2 flex items-center gap-2 px-3 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors border border-gray-700 text-sm"
        >
          <Plus size={16} />
          <span>{mode === 'agent' ? 'New agent session' : mode === 'editor' ? 'New project' : 'New chat'}</span>
        </button>

        {/* Search */}
        <div className="mx-3 mt-2 mb-2 relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-gray-800 text-sm text-gray-300 placeholder-gray-500 rounded-lg pl-8 pr-3 py-2 border border-gray-700 outline-none focus:border-gray-600 transition-colors"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {(() => {
            const q = searchQuery.toLowerCase().trim();
            const filtered = conversations.filter((c) => {
              if ((c.mode || 'chat') !== mode) return false;
              if (!q) return true;
              if (c.title.toLowerCase().includes(q)) return true;
              return c.messages.some((m) => m.content.toLowerCase().includes(q));
            });
            if (loading && !searchQuery) {
              return (
                <div className="space-y-1 px-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <ConversationSkeleton key={i} />
                  ))}
                </div>
              );
            }
            if (filtered.length === 0) {
              return (
                <p className="text-gray-500 text-sm text-center mt-8 px-4">
                  {searchQuery
                    ? `No results for "${searchQuery}"`
                    : mode === 'agent'
                      ? 'No agent sessions yet.'
                      : 'No conversations yet.'}
                </p>
              );
            }

            // Group agent conversations by project/workspace
            if (mode === 'agent') {
              const groups = new Map<string, typeof filtered>();
              for (const conv of filtered) {
                const project = conv.workspacePath ? getProjectName(conv.workspacePath) : 'Other';
                if (!groups.has(project)) groups.set(project, []);
                groups.get(project)!.push(conv);
              }
              // Sort groups: most recently updated first
              const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
                const latestA = Math.max(...a[1].map((c) => c.updatedAt));
                const latestB = Math.max(...b[1].map((c) => c.updatedAt));
                return latestB - latestA;
              });

              return (
                <>
                  {searchQuery && (
                    <p className="px-3 pb-1 text-xs text-gray-500">
                      {filtered.length} session{filtered.length !== 1 ? 's' : ''} found
                    </p>
                  )}
                  <div className="space-y-2">
                    {sortedGroups.map(([project, convs]) => {
                      const isExpanded = expandedProjects.has(project);
                      const sortedConvs = convs.sort((a, b) => b.updatedAt - a.updatedAt);
                      const latest = sortedConvs[0];
                      return (
                        <div key={project}>
                          {/* Project group header */}
                          <button
                            onClick={() => toggleProject(project)}
                            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                              isExpanded ? 'bg-gray-800/50' : 'hover:bg-gray-800/30'
                            }`}
                          >
                            {isExpanded ? (
                              <ChevronDown size={12} className="text-gray-500 flex-shrink-0" />
                            ) : (
                              <ChevronRight size={12} className="text-gray-500 flex-shrink-0" />
                            )}
                            <FolderOpen size={14} className="text-purple-400 flex-shrink-0" />
                            <span className="flex-1 text-xs font-medium text-gray-300 truncate text-left">
                              {project}
                            </span>
                            <span className="text-[10px] text-gray-600 flex-shrink-0">
                              {convs.length}
                            </span>
                            {!isExpanded && (
                              <span className="text-[10px] text-gray-500 truncate max-w-[80px] text-right">
                                {latest?.title || ''}
                              </span>
                            )}
                          </button>

                          {/* Conversation list */}
                          {isExpanded && (
                            <div className="ml-4 mt-0.5 space-y-0.5 border-l border-gray-800 pl-2">
                              {sortedConvs.map((conv) => {
                                const contentMatch = searchQuery
                                  ? findMessageMatch(conv, searchQuery)
                                  : null;
                                const matchCount = searchQuery
                                  ? countMatches(conv, searchQuery)
                                  : 0;
                                return (
                                  <div key={conv.id}>
                                    {editingId === conv.id ? (
                                      <div className="flex items-center gap-1 px-2 py-1.5 bg-gray-800 rounded-lg">
                                        <input
                                          ref={inputRef}
                                          type="text"
                                          value={editValue}
                                          onChange={(e) => setEditValue(e.target.value)}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') commitEdit();
                                            if (e.key === 'Escape') setEditingId(null);
                                          }}
                                          onBlur={commitEdit}
                                          className="flex-1 bg-transparent text-sm outline-none px-1"
                                        />
                                        <button onClick={commitEdit} className="p-1 hover:bg-gray-700 rounded">
                                          <Check size={14} />
                                        </button>
                                      </div>
                                    ) : (
                                      <div
                                        className={`group flex flex-col px-2 py-1.5 rounded-lg cursor-pointer transition-all duration-200 ${
                                          activeId === conv.id ? 'bg-gray-800 shadow-sm' : 'hover:bg-gray-800/50'
                                        }`}
                                        onClick={() => onSelect(conv.id)}
                                      >
                                        <div className="flex items-center gap-2 min-w-0">
                                          <Wrench size={12} className="flex-shrink-0 text-purple-400" />
                                          <div
                                            className="w-6 h-6 rounded-lg flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0 shadow-sm"
                                            style={{ backgroundColor: getAvatarColor(conv.id + conv.title) }}
                                          >
                                            {getInitials(conv.title)}
                                          </div>
                                          <span className="flex-1 text-xs truncate">{conv.title}</span>
                                          {matchCount > 0 && (
                                            <span className="text-xs text-amber-400/70 flex-shrink-0 mr-1">
                                              {matchCount}
                                            </span>
                                          )}
                                          <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 flex-shrink-0">
                                            <button
                                              onClick={(e) => { e.stopPropagation(); startEdit(conv); }}
                                              className="p-0.5 hover:bg-gray-700 rounded"
                                              aria-label="Rename"
                                            >
                                              <Edit2 size={10} />
                                            </button>
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                onDelete(conv.id);
                                                toast('success', 'Session deleted');
                                              }}
                                              className="p-0.5 hover:bg-gray-700 rounded text-red-400"
                                              aria-label="Delete"
                                            >
                                              <Trash2 size={10} />
                                            </button>
                                          </div>
                                        </div>
                                        {contentMatch && (
                                          <div className="mt-0.5 ml-8 text-[10px] text-gray-500 truncate leading-relaxed">
                                            <span className={`font-medium ${contentMatch.role === 'You' ? 'text-blue-400' : 'text-green-400'}`}>
                                              {contentMatch.role}
                                            </span>
                                            : {contentMatch.snippet}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            }

            // Flat list for chat/editor modes
            return (
              <>
                {searchQuery && (
                  <p className="px-3 pb-1 text-xs text-gray-500">
                    {filtered.length} conversation{filtered.length !== 1 ? 's' : ''} found
                  </p>
                )}
                <ul className="space-y-0.5">
                  {filtered.map((conv) => {
                    const contentMatch = searchQuery
                      ? findMessageMatch(conv, searchQuery)
                      : null;
                    const matchCount = searchQuery
                      ? countMatches(conv, searchQuery)
                      : 0;
                    return (
                <li key={conv.id}>
                  {editingId === conv.id ? (
                    <div className="flex items-center gap-1 px-2 py-1.5 bg-gray-800 rounded-lg">
                      <input
                        ref={inputRef}
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit();
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        onBlur={commitEdit}
                        className="flex-1 bg-transparent text-sm outline-none px-1"
                      />
                      <button onClick={commitEdit} className="p-1 hover:bg-gray-700 rounded">
                        <Check size={14} />
                      </button>
                    </div>
                  ) : (
                    <div
                      className={`group flex flex-col px-3 py-2 rounded-lg cursor-pointer transition-all duration-200 ${
                        activeId === conv.id ? 'bg-gray-800 shadow-sm' : 'hover:bg-gray-800/60'
                      }`}
                      onClick={() => onSelect(conv.id)}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {/* Mode icon */}
                        {conv.mode === 'editor' ? (
                          <Film size={14} className="flex-shrink-0 text-red-400" />
                        ) : (
                          <MessageSquare size={14} className="flex-shrink-0 text-gray-400" />
                        )}
                        <div
                          className="w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0 shadow-sm"
                          style={{ backgroundColor: getAvatarColor(conv.id + conv.title) }}
                          title={conv.title}
                        >
                          {getInitials(conv.title)}
                        </div>
                      <span className="flex-1 text-sm truncate">{conv.title}</span>
                      {matchCount > 0 && (
                        <span className="text-xs text-amber-400/70 flex-shrink-0 mr-1">
                          {matchCount} match{matchCount !== 1 ? 'es' : ''}
                        </span>
                      )}
                      <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 flex-shrink-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); startEdit(conv); }}
                          className="p-1 hover:bg-gray-700 rounded"
                          aria-label="Rename"
                        >
                          <Edit2 size={12} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(conv.id);
                            toast('success', 'Conversation deleted');
                          }}
                          className="p-1 hover:bg-gray-700 rounded text-red-400"
                          aria-label="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                      </div>
                      {contentMatch && (
                        <div className="mt-1 ml-7 text-xs text-gray-500 truncate leading-relaxed">
                          <span className={`font-medium ${contentMatch.role === 'You' ? 'text-blue-400' : 'text-green-400'}`}>
                            {contentMatch.role}
                          </span>
                          : {contentMatch.snippet}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )})}
                </ul>
              </>
            );
          })()}
        </div>

        <UserBadge profile={user} onSwitch={onSwitchUser} onSettings={onUserSettings} />
      </aside>
    </>
  );
}
