import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Plus, Trash2, Edit2, X, Check, Menu } from 'lucide-react';
import type { Conversation } from '../types';
import type { UserProfile } from '../types';
import { UserBadge } from './UserBadge';

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
}

export function Sidebar({
  conversations, activeId, onSelect, onCreate, onDelete, onRename,
  isOpen, onClose, user, onSwitchUser,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

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
            AI Chat
          </h1>
          <button
            onClick={onClose}
            className="md:hidden p-1.5 hover:bg-gray-800 rounded"
            aria-label="Close sidebar"
          >
            <X size={18} />
          </button>
        </div>

        <button
          onClick={onCreate}
          className="m-3 flex items-center gap-2 px-3 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors border border-gray-700 text-sm"
        >
          <Plus size={16} />
          <span>New chat</span>
        </button>

        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {conversations.length === 0 ? (
            <p className="text-gray-500 text-sm text-center mt-8 px-4">
              No conversations yet.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {conversations.map((conv) => (
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
                      className={`group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                        activeId === conv.id ? 'bg-gray-800' : 'hover:bg-gray-800/60'
                      }`}
                      onClick={() => onSelect(conv.id)}
                    >
                      <MessageSquare size={14} className="flex-shrink-0 text-gray-400" />
                      <span className="flex-1 text-sm truncate">{conv.title}</span>
                      <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5">
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
                            if (confirm('Delete this conversation?')) onDelete(conv.id);
                          }}
                          className="p-1 hover:bg-gray-700 rounded text-red-400"
                          aria-label="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <UserBadge profile={user} onSwitch={onSwitchUser} />
      </aside>
    </>
  );
}
