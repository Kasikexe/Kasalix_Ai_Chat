import { useState, useEffect, useRef } from 'react';
import {
  X, User, Palette, Copy, Check, Key, Brain,
  LogOut, Pencil, CheckCircle, AtSign, Shield, Sun, Moon,
  Database, Plus, Trash2, Edit3, BookOpen, RefreshCw,
} from 'lucide-react';
import type { UserProfile, MemoryData } from '../types';

const COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
];

interface Props {
  open: boolean;
  onClose: () => void;
  profile: UserProfile;
  onUpdate: (updates: Partial<UserProfile>) => UserProfile;
  onSwitch: () => void;
  thinkingEnabled: boolean;
  onToggleThinking: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  memoryEnabled: boolean;
  memoryCategories: Record<string, Record<string, string>>;
  onToggleMemory: () => void;
  onAddMemoryEntry: (category: string, key: string, value: string) => void;
  onEditMemoryEntry: (category: string, key: string, value: string) => void;
  onRemoveMemoryEntry: (category: string, key: string) => void;
  onAddMemoryCategory: (category: string) => void;
  onRemoveMemoryCategory: (category: string) => void;
  onResetMemory: () => void;
  onRefreshMemory?: () => void;
}

export function UserSettingsModal({
  open, onClose, profile, onUpdate, onSwitch,
  thinkingEnabled, onToggleThinking,
  theme, onToggleTheme,
  memoryEnabled, memoryCategories,
  onToggleMemory,
  onAddMemoryEntry, onEditMemoryEntry, onRemoveMemoryEntry,
  onAddMemoryCategory, onRemoveMemoryCategory,
  onResetMemory,
  onRefreshMemory,
}: Props) {
  const [name, setName] = useState(profile.name);
  const [selectedColor, setSelectedColor] = useState(profile.color);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Memory UI state
  const [memoryExpanded, setMemoryExpanded] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [editingEntry, setEditingEntry] = useState<{ category: string; key: string; value: string } | null>(null);
  const [addingEntry, setAddingEntry] = useState<{ category: string } | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editValue, setEditValue] = useState('');
  const [addCategoryOpen, setAddCategoryOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

  // Reset state when profile changes or modal opens
  useEffect(() => {
    if (open) {
      setName(profile.name);
      setSelectedColor(profile.color);
      setIsEditing(false);
      setSaved(false);
      // Refresh memory data from backend when modal opens
      onRefreshMemory?.();
    }
  }, [open, profile, onRefreshMemory]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      // Focus name input when entering edit mode
      if (isEditing && inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open, isEditing]);

  const copyId = async () => {
    await navigator.clipboard.writeText(profile.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const saveName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== profile.name) {
      onUpdate({ name: trimmed, color: selectedColor });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      setName(profile.name);
    }
    setIsEditing(false);
  };

  const handleColorSelect = (color: string) => {
    setSelectedColor(color);
    onUpdate({ color });
  };

  const handleSwitch = () => {
    if (confirm('Switch user? You will return to the welcome screen.')) {
      onClose();
      onSwitch();
    }
  };

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const startAddEntry = (category: string) => {
    setAddingEntry({ category });
    setNewKey('');
    setNewValue('');
  };

  const confirmAddEntry = () => {
    if (addingEntry && newKey.trim() && newValue.trim()) {
      onAddMemoryEntry(addingEntry.category, newKey.trim(), newValue.trim());
      setAddingEntry(null);
      setNewKey('');
      setNewValue('');
    }
  };

  const startEditEntry = (category: string, key: string, value: string) => {
    setEditingEntry({ category, key, value });
    setEditValue(value);
  };

  const confirmEditEntry = () => {
    if (editingEntry && editValue.trim()) {
      onEditMemoryEntry(editingEntry.category, editingEntry.key, editValue.trim());
      setEditingEntry(null);
      setEditValue('');
    }
  };

  const confirmAddCategory = () => {
    if (newCategoryName.trim()) {
      onAddMemoryCategory(newCategoryName.trim());
      setNewCategoryName('');
      setAddCategoryOpen(false);
      // Auto-expand the new category
      setTimeout(() => {
        setExpandedCategories((prev) => {
          const next = new Set(prev);
          next.add(newCategoryName.trim());
          return next;
        });
      }, 100);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={modalRef}
        className="w-full max-w-lg max-h-[90vh] flex flex-col bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl animate-fade-in"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-600/20 rounded-xl">
              <User size={20} className="text-blue-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">User Settings</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Customize your profile and preferences
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-800 rounded-xl text-gray-400 hover:text-gray-200 transition-colors"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Avatar & Name Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              {/* Avatar */}
              <div className="relative group">
                <div
                  className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-bold text-white shadow-lg transition-transform duration-200 group-hover:scale-105"
                  style={{ backgroundColor: selectedColor }}
                >
                  {profile.name.charAt(0).toUpperCase()}
                </div>
                <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-gray-900 rounded-full flex items-center justify-center border border-gray-700">
                  <Palette size={10} className="text-gray-400" />
                </div>
              </div>

              {/* Name */}
              <div className="flex-1 min-w-0">
                {isEditing ? (
                  <div className="flex items-center gap-2">
                    <input
                      ref={inputRef}
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveName();
                        if (e.key === 'Escape') { setIsEditing(false); setName(profile.name); }
                      }}
                      onBlur={saveName}
                      maxLength={24}
                      placeholder="Your name"
                      className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600/30 transition-all"
                    />
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div>
                      <p className="text-base font-semibold text-white">{profile.name}</p>
                      <p className="text-xs text-gray-500">Display name</p>
                    </div>
                    <button
                      onClick={() => setIsEditing(true)}
                      className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-blue-400 transition-colors"
                      title="Edit name"
                    >
                      <Pencil size={14} />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Save confirmation */}
            {saved && (
              <div className="flex items-center gap-2 px-3 py-2 bg-emerald-900/30 border border-emerald-800/50 rounded-lg text-xs text-emerald-400 animate-fade-in">
                <CheckCircle size={14} />
                Profile updated successfully
              </div>
            )}
          </div>

          {/* Color Picker */}
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
              <Palette size={16} className="text-gray-500" />
              Avatar Color
            </label>
            <div className="flex gap-2.5">
              {COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => handleColorSelect(color)}
                  className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200 ${
                    selectedColor === color
                      ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-900 scale-110 shadow-lg'
                      : 'hover:scale-110 hover:shadow-md'
                  }`}
                  style={{ backgroundColor: color }}
                  title={color}
                >
                  {selectedColor === color && (
                    <Check size={16} className="text-white drop-shadow" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Theme Toggle */}
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
              {theme === 'dark' ? <Moon size={16} className="text-gray-500" /> : <Sun size={16} className="text-gray-500" />}
              Appearance
            </label>

            <div
              className="flex items-center justify-between px-4 py-3 rounded-xl cursor-pointer transition-all duration-200 bg-gray-800/50 border border-gray-800 hover:bg-gray-800"
              onClick={onToggleTheme}
            >
              <div className="flex items-center gap-3">
                <div className="p-1.5 bg-gray-700/50 rounded-lg">
                  {theme === 'dark' ? (
                    <Moon size={18} className="text-blue-400" />
                  ) : (
                    <Sun size={18} className="text-amber-500" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium text-white">
                    {theme === 'dark' ? 'Dark Mode' : 'Light Mode'}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {theme === 'dark'
                      ? 'Easy on the eyes, great for low light'
                      : 'Bright and clean, great for daytime'}
                  </p>
                </div>
              </div>
              <div
                className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
                  theme === 'dark' ? 'bg-blue-600' : 'bg-amber-500'
                }`}
              >
                <div
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${
                    theme === 'dark' ? 'translate-x-0' : 'translate-x-5'
                  }`}
                />
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-gray-800" />

          {/* Preferences */}
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
              <Brain size={16} className="text-gray-500" />
              Preferences
            </label>

            {/* Thinking mode toggle */}
            <div
              className={`flex items-center justify-between px-4 py-3 rounded-xl cursor-pointer transition-all duration-200 ${
                thinkingEnabled
                  ? 'bg-purple-900/20 border border-purple-800/40'
                  : 'bg-gray-800/50 border border-gray-800 hover:bg-gray-800'
              }`}
              onClick={onToggleThinking}
            >
              <div className="flex items-center gap-3">
                <div className={`p-1.5 rounded-lg ${thinkingEnabled ? 'bg-purple-700/30' : 'bg-gray-700/50'}`}>
                  <Brain size={18} className={thinkingEnabled ? 'text-purple-400' : 'text-gray-400'} />
                </div>
                <div>
                  <p className="text-sm font-medium text-white">Thinking Mode</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {thinkingEnabled
                      ? 'Slower but smarter responses with reasoning'
                      : 'Faster, more direct responses'}
                  </p>
                </div>
              </div>
              <div
                className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
                  thinkingEnabled ? 'bg-purple-600' : 'bg-gray-700'
                }`}
              >
                <div
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${
                    thinkingEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-gray-800" />

          {/* Memory Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
                <Database size={16} className="text-gray-500" />
                AI Memory
              </label>
              <button
                onClick={() => setMemoryExpanded(!memoryExpanded)}
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                {memoryExpanded ? 'Less' : 'Manage'}
              </button>
            </div>

            {/* Memory toggle */}
            <div
              className={`flex items-center justify-between px-4 py-3 rounded-xl cursor-pointer transition-all duration-200 ${
                memoryEnabled
                  ? 'bg-emerald-900/20 border border-emerald-800/40'
                  : 'bg-gray-800/50 border border-gray-800 hover:bg-gray-800'
              }`}
              onClick={onToggleMemory}
            >
              <div className="flex items-center gap-3">
                <div className={`p-1.5 rounded-lg ${memoryEnabled ? 'bg-emerald-700/30' : 'bg-gray-700/50'}`}>
                  <Brain size={18} className={memoryEnabled ? 'text-emerald-400' : 'text-gray-400'} />
                </div>
                <div>
                  <p className="text-sm font-medium text-white">Memory {memoryEnabled ? 'On' : 'Off'}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {memoryEnabled
                      ? `AI remembers ${Object.keys(memoryCategories).length} categories about you`
                      : 'AI won\'t remember personal information'}
                  </p>
                </div>
              </div>
              <div
                className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
                  memoryEnabled ? 'bg-emerald-600' : 'bg-gray-700'
                }`}
              >
                <div
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${
                    memoryEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </div>
            </div>

            {/* Expanded memory management */}
            {memoryExpanded && (
              <div className="space-y-3 animate-fade-in">
                {/* Memory info badge */}
                {memoryEnabled && Object.keys(memoryCategories).length === 0 && (
                  <p className="text-xs text-gray-500 text-center py-2">
                    Memory is on but empty. The AI will learn about you as you chat.
                  </p>
                )}

                {/* Categories */}
                {Object.entries(memoryCategories).map(([category, entries]) => (
                  <div key={category} className="rounded-xl border border-gray-800 overflow-hidden">
                    {/* Category header */}
                    <div
                      className="flex items-center justify-between px-3 py-2.5 bg-gray-800/50 cursor-pointer hover:bg-gray-800 transition-colors"
                      onClick={() => toggleCategory(category)}
                    >
                      <div className="flex items-center gap-2">
                        <BookOpen size={14} className="text-blue-400" />
                        <span className="text-sm font-medium text-white">#{category}</span>
                        <span className="text-xs text-gray-500">({Object.keys(entries).length})</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); startAddEntry(category); }}
                          className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-gray-200 transition-colors"
                          title="Add entry"
                        >
                          <Plus size={12} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Delete entire "${category}" category?`)) onRemoveMemoryCategory(category);
                          }}
                          className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-red-400 transition-colors"
                          title="Delete category"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>

                    {/* Expanded entries */}
                    {expandedCategories.has(category) && (
                      <div className="px-3 py-2 space-y-1.5 border-t border-gray-800">
                        {Object.entries(entries).length === 0 && !addingEntry && (
                          <p className="text-xs text-gray-500 text-center py-2">No entries yet</p>
                        )}

                        {/* Adding new entry */}
                        {addingEntry?.category === category && (
                          <div className="flex items-center gap-2 p-2 bg-gray-800/30 rounded-lg">
                            <input
                              type="text"
                              value={newKey}
                              onChange={(e) => setNewKey(e.target.value)}
                              placeholder="Key (e.g., age)"
                              className="flex-1 min-w-0 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white placeholder-gray-500 outline-none focus:border-blue-600"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') confirmAddEntry();
                                if (e.key === 'Escape') setAddingEntry(null);
                              }}
                              autoFocus
                            />
                            <input
                              type="text"
                              value={newValue}
                              onChange={(e) => setNewValue(e.target.value)}
                              placeholder="Value"
                              className="flex-1 min-w-0 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white placeholder-gray-500 outline-none focus:border-blue-600"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') confirmAddEntry();
                                if (e.key === 'Escape') setAddingEntry(null);
                              }}
                            />
                            <button
                              onClick={confirmAddEntry}
                              className="p-1 bg-blue-600 hover:bg-blue-500 rounded text-white transition-colors"
                              disabled={!newKey.trim() || !newValue.trim()}
                            >
                              <Check size={12} />
                            </button>
                          </div>
                        )}

                        {Object.entries(entries).map(([key, value]) => (
                          <div key={key} className="group flex items-center gap-2">
                            {editingEntry?.category === category && editingEntry.key === key ? (
                              <div className="flex items-center gap-1 flex-1">
                                <span className="text-xs text-gray-400 font-medium whitespace-nowrap">{key}:</span>
                                <input
                                  type="text"
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  className="flex-1 px-2 py-0.5 bg-gray-800 border border-gray-700 rounded text-xs text-white outline-none focus:border-blue-600"
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') confirmEditEntry();
                                    if (e.key === 'Escape') setEditingEntry(null);
                                  }}
                                  onBlur={confirmEditEntry}
                                  autoFocus
                                />
                              </div>
                            ) : (
                              <>
                                <span className="text-xs text-gray-400 font-medium whitespace-nowrap">{key}:</span>
                                <span className="text-xs text-gray-200">{value}</span>
                                <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button
                                    onClick={() => startEditEntry(category, key, value)}
                                    className="p-0.5 hover:bg-gray-700 rounded text-gray-500 hover:text-gray-300"
                                    title="Edit"
                                  >
                                    <Edit3 size={10} />
                                  </button>
                                  <button
                                    onClick={() => onRemoveMemoryEntry(category, key)}
                                    className="p-0.5 hover:bg-gray-700 rounded text-gray-500 hover:text-red-400"
                                    title="Delete"
                                  >
                                    <Trash2 size={10} />
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}

                {/* Add category */}
                {addCategoryOpen ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={newCategoryName}
                      onChange={(e) => setNewCategoryName(e.target.value)}
                      placeholder="Category name (e.g., Education)"
                      className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-xs text-white placeholder-gray-500 outline-none focus:border-blue-600"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') confirmAddCategory();
                        if (e.key === 'Escape') { setAddCategoryOpen(false); setNewCategoryName(''); }
                      }}
                      autoFocus
                    />
                    <button
                      onClick={confirmAddCategory}
                      className="p-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-white transition-colors"
                      disabled={!newCategoryName.trim()}
                    >
                      <Check size={14} />
                    </button>
                    <button
                      onClick={() => { setAddCategoryOpen(false); setNewCategoryName(''); }}
                      className="p-2 hover:bg-gray-800 rounded-lg text-gray-400"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setAddCategoryOpen(true)}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-gray-800/30 border border-dashed border-gray-700 hover:border-gray-600 rounded-xl text-xs text-gray-400 hover:text-gray-200 transition-all"
                  >
                    <Plus size={12} />
                    Add Category
                  </button>
                )}

                {/* Reset memory */}
                {Object.keys(memoryCategories).length > 0 && (
                  <button
                    onClick={() => {
                      if (confirm('Clear all memory? The AI will forget everything about you.')) onResetMemory();
                    }}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-red-900/10 border border-red-900/30 hover:bg-red-900/20 rounded-xl text-xs text-red-400 hover:text-red-300 transition-all"
                  >
                    <RefreshCw size={12} />
                    Clear All Memory
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="border-t border-gray-800" />

          {/* User Info */}
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
              <Shield size={16} className="text-gray-500" />
              Account
            </label>

            {/* User ID */}
            <div className="px-4 py-3 bg-gray-800/30 border border-gray-800 rounded-xl">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-500">User ID</span>
                <button
                  onClick={copyId}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded-lg transition-colors"
                >
                  {copied ? (
                    <>
                      <Check size={12} className="text-emerald-400" />
                      <span className="text-emerald-400">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy size={12} />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
              <code className="text-xs text-gray-400 font-mono break-all select-all">
                {profile.id}
              </code>
            </div>

            {/* Switch user */}
            <button
              onClick={handleSwitch}
              className="w-full flex items-center gap-3 px-4 py-3 bg-gray-800/30 border border-gray-800 hover:bg-gray-800 hover:border-gray-700 rounded-xl transition-all duration-200 group"
            >
              <div className="p-1.5 bg-gray-700/50 rounded-lg group-hover:bg-gray-700 transition-colors">
                <LogOut size={16} className="text-gray-400" />
              </div>
              <div className="text-left flex-1">
                <p className="text-sm font-medium text-gray-300 group-hover:text-white transition-colors">Switch User</p>
                <p className="text-xs text-gray-500">Return to the welcome screen</p>
              </div>
              <LogOut size={16} className="text-gray-500 group-hover:text-gray-300 transition-colors" />
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-800 text-center">
          <p className="text-xs text-gray-600">
            Profile data is stored locally on this device
          </p>
        </div>
      </div>
    </div>
  );
}
