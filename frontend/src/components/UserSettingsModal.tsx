import { useState, useEffect, useRef } from 'react';
import {
 X, User, Palette, Copy, Check, Brain, Bot,
 LogOut, Pencil, CheckCircle, Shield, Sun, Moon,
 Database, Plus, Trash2, Edit3, BookOpen, RefreshCw, Quote,
 Thermometer, Gauge, AlignLeft, Sparkles, Sliders,
 ArrowUpCircle, Download, Package, Settings2, MonitorOff,
} from 'lucide-react';
import type { UserProfile, MemoryData } from '../types';
import { useToast } from '../hooks/useToast';
import { getSavedServerUrl } from '../services/api';

const AUTO_UPDATE_KEY = 'ai-chat:autoUpdate';

/** Hostname of the backend that actually stores conversations/accounts/settings.
 *  Data lives on the machine running the Kasalix server — not necessarily the
 *  device the client runs on (the client only keeps its session token). */
function serverHost(): { host: string; local: boolean } {
  const saved = getSavedServerUrl();
  let host = 'localhost';
  if (saved) {
    try { host = new URL(saved).hostname; } catch { host = saved.replace(/^https?:\/\//, ''); }
  }
  return { host, local: ['localhost', '127.0.0.1', '::1'].includes(host) };
}

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
 /** False when the chat model can't do thinking — hides the toggle entirely */
 thinkingSupported?: boolean;
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

type TabId = 'profile' | 'preferences' | 'appearance' | 'memory' | 'account';
type Section = 'core' | 'koding';

interface TabDef {
 id: TabId;
 label: string;
 icon: React.ReactNode;
}

const TABS: TabDef[] = [
 { id: 'profile', label: 'Profile', icon: <User size={16} /> },
 { id: 'preferences', label: 'AI', icon: <Brain size={16} /> },
 { id: 'appearance', label: 'Theme', icon: <Sun size={16} /> },
 { id: 'memory', label: 'Memory', icon: <Database size={16} /> },
 { id: 'account', label: 'Account', icon: <Shield size={16} /> },
];

export function UserSettingsModal({
 open, onClose, profile, onUpdate, onSwitch,
 thinkingEnabled, onToggleThinking, thinkingSupported,
 theme, onToggleTheme,
 memoryEnabled, memoryCategories,
 onToggleMemory,
 onAddMemoryEntry, onEditMemoryEntry, onRemoveMemoryEntry,
 onAddMemoryCategory, onRemoveMemoryCategory,
 onResetMemory,
 onRefreshMemory,
}: Props) {
 const [activeTab, setActiveTab] = useState<TabId>('profile');
 const [section, setSection] = useState<Section>('core');
 const [name, setName] = useState(profile.name);
 const [selectedColor, setSelectedColor] = useState(profile.color);
 const [copied, setCopied] = useState(false);
 const [saved, setSaved] = useState(false);
 const [isEditing, setIsEditing] = useState(false);
 const inputRef = useRef<HTMLInputElement>(null);
 const modalRef = useRef<HTMLDivElement>(null);
 const tabBarRef = useRef<HTMLDivElement>(null);
 const { toast } = useToast();

 // Memory UI state
 const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
 const [editingEntry, setEditingEntry] = useState<{ category: string; key: string; value: string } | null>(null);
 const [addingEntry, setAddingEntry] = useState<{ category: string } | null>(null);
 const [newKey, setNewKey] = useState('');
 const [newValue, setNewValue] = useState('');
 const [editValue, setEditValue] = useState('');
 const [addCategoryOpen, setAddCategoryOpen] = useState(false);
 const [newCategoryName, setNewCategoryName] = useState('');

 // Advanced settings state
 const [temperature, setTemperature] = useState(() => parseFloat(localStorage.getItem('ai-chat:temperature') ?? '0.7') || 0.7);
 const [topP, setTopP] = useState(() => parseFloat(localStorage.getItem('ai-chat:top_p') ?? '0.9') || 0.9);
 const [maxTokens, setMaxTokens] = useState(() => parseInt(localStorage.getItem('ai-chat:maxTokens') ?? '4096') || 4096);
 const [autoTitle, setAutoTitle] = useState(() => localStorage.getItem('ai-chat:autoTitle') !== 'false');
 const [showAdvanced, setShowAdvanced] = useState(false);

 // App version (Electron only)
 const [appVersion, setAppVersion] = useState<string | null>(null);
 const [checkingUpdates, setCheckingUpdates] = useState(false);

 // Auto-update state
 const [autoUpdate, setAutoUpdate] = useState(() => localStorage.getItem(AUTO_UPDATE_KEY) !== 'false');

 // Koding preview preference (window hidden vs shown)
 const [previewHidden, setPreviewHidden] = useState(false);
 useEffect(() => {
 if (!open) return;
 const api = (window as any).electronAPI;
 if (api?.getPreviewPreference) {
 api.getPreviewPreference().then((r: any) => setPreviewHidden(!!(r && r.hidden))).catch(() => {});
 }
 }, [open]);
 const togglePreviewHidden = async () => {
 const next = !previewHidden;
 setPreviewHidden(next);
 try {
 localStorage.setItem('ai-chat:previewHidden', String(next));
 const api = (window as any).electronAPI;
 if (api?.setPreviewPreference) await api.setPreviewPreference(next);
 } catch {}
 };

 // System prompt state
 const [systemPrompt, setSystemPrompt] = useState<string>('');
 const [systemPromptSaved, setSystemPromptSaved] = useState(false);
 const SYSTEM_PROMPT_KEY = 'ai-chat:systemPrompt';

 // Load system prompt on mount
 useEffect(() => {
 try {
 const stored = localStorage.getItem(SYSTEM_PROMPT_KEY);
 if (stored) setSystemPrompt(stored);
 } catch {}
 }, []);

 const saveSystemPrompt = (value: string) => {
 setSystemPrompt(value);
 try {
 localStorage.setItem(SYSTEM_PROMPT_KEY, value);
 setSystemPromptSaved(true);
 setTimeout(() => setSystemPromptSaved(false), 2000);
 } catch {}
 };

 // Reset state when profile changes or modal opens
 useEffect(() => {
 if (open) {
 setName(profile.name);
 setSelectedColor(profile.color);
 setIsEditing(false);
 setSaved(false);
 setActiveTab('profile');
 setSection('core');
 // Refresh memory data from backend when modal opens
 onRefreshMemory?.();
 // Fetch app version from Electron main process
 const isE = typeof window !== 'undefined' && !!(window as any).electronAPI?.isElectron;
 if (isE) {
 (async () => {
 try {
 const result = await (window as any).electronAPI.getAppVersion();
 setAppVersion(result?.version || null);
 } catch { setAppVersion(null); }
 })();
 }
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
 onClose();
 onSwitch();
 toast('info', 'Switching user...');
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

 // Auto-scroll active tab into view
 useEffect(() => {
 if (!open) return;
 const el = tabBarRef.current?.querySelector(`[data-tab-id="${activeTab}"]`) as HTMLElement | null | undefined;
 if (el) {
 el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
 }
 }, [activeTab, open]);

 const confirmAddCategory = () => {
 if (newCategoryName.trim()) {
 onAddMemoryCategory(newCategoryName.trim());
 setNewCategoryName('');
 setAddCategoryOpen(false);
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
 className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70"
 onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
 >
 <div
 ref={modalRef}
 className="w-full max-w-lg max-h-[90vh] flex flex-col bg-gray-900 border border-gray-800 rounded-lg animate-fade-in"
 >
 {/* Header */}
 <div className="flex items-center justify-between p-5 pb-3 border-b border-gray-800">
 <div className="flex items-center gap-3">
 <div className="p-2 bg-[#2a3a52]/20 rounded-xl">
 <User size={20} className="text-[#7b9fc6]"/>
 </div>
 <div>
 <h2 className="text-lg font-semibold text-white">Settings</h2>
 <p className="text-xs text-gray-500 mt-0.5">
 Customize your experience
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

 {/* Core / Agent section toggle */}
 <div className="flex items-center gap-1 px-3 pt-3">
 {(['core', 'koding'] as Section[]).map((s) => (
 <button
 key={s}
 onClick={() => setSection(s)}
 className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
 section === s
 ? 'bg-gray-800 text-white shadow'
 : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
 }`}
 >
 {s === 'core' ? <Settings2 size={13} /> : <Bot size={13} />}
 <span className="capitalize">{s}</span>
 </button>
 ))}
 <span className="ml-auto pr-1 text-[10px] text-gray-600">Core = app-wide · Koding = Koding only</span>
 </div>

 {/* Tab Bar (Core section only) */}
 {section === 'core' && (
 <div
 ref={tabBarRef}
 className="flex overflow-x-auto border-b border-gray-800 px-2 pt-2 gap-1 scrollbar-none"
 >
 {TABS.map((tab) => (
 <button
 key={tab.id}
 data-tab-id={tab.id}
 onClick={() => setActiveTab(tab.id)}
 className={`flex items-center gap-1.5 px-3 py-2.5 rounded-t-lg text-xs font-medium transition-all duration-200 whitespace-nowrap ${
 activeTab === tab.id
 ? 'bg-gray-800 text-white border-b-2 border-blue-500'
 : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
 }`}
 >
 {tab.icon}
 <span>{tab.label}</span>
 </button>
 ))}
 </div>
 )}

 {/* Scrollable Content */}
 <div className="flex-1 overflow-y-auto p-5 space-y-6">
 {section === 'core' && (
 <>
 {/* ==================== PROFILE TAB ==================== */}
 {activeTab === 'profile' && (
 <div key="tab-profile"className="space-y-6 animate-fade-in">
 {/* Avatar & Name */}
 <div className="space-y-4">
 <div className="flex items-center gap-4">
 {/* Avatar */}
 <div className="relative group">
 <div
 className="w-16 h-16 rounded-lg flex items-center justify-center text-2xl font-bold text-white transition-transform duration-200 group-hover:scale-105"
 style={{ backgroundColor: selectedColor }}
 >
 {profile.name.charAt(0).toUpperCase()}
 </div>
 <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-gray-900 rounded-full flex items-center justify-center border border-gray-700">
 <Palette size={10} className="text-gray-400"/>
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
 className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-[#7b9fc6] transition-colors"
 title="Edit name"
 >
 <Pencil size={14} />
 </button>
 </div>
 )}
 </div>
 </div>

 {saved && (
 <div className="flex items-center gap-2 px-3 py-2 bg-emerald-900/30 border border-[#1a3a33] rounded-lg text-xs text-[#4a9988] animate-fade-in">
 <CheckCircle size={14} />
 Profile updated successfully
 </div>
 )}
 </div>

 {/* Color Picker */}
 <div className="space-y-3">
 <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
 <Palette size={16} className="text-gray-500"/>
 Avatar Color
 </label>
 <div className="flex gap-2.5">
 {COLORS.map((color) => (
 <button
 key={color}
 onClick={() => handleColorSelect(color)}
 className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200 ${
 selectedColor === color
 ? ' scale-110 '
 : 'hover:scale-110 hover:shadow-md'
 }`}
 style={{ backgroundColor: color }}
 title={color}
 >
 {selectedColor === color && (
 <Check size={16} className="text-white drop-shadow"/>
 )}
 </button>
 ))}
 </div>
 </div>

 {/* User Info */}
 <div className="space-y-3 pt-2">
 <div className="px-4 py-3 bg-gray-800/30 border border-gray-800 rounded-xl">
 <div className="flex items-center justify-between mb-1">
 <span className="text-xs text-gray-500">User ID</span>
 <button
 onClick={copyId}
 className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded-lg transition-colors"
 >
 {copied ? (
 <>
 <Check size={12} className="text-[#4a9988]"/>
 <span className="text-[#4a9988]">Copied</span>
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
 </div>

 {/* Footer */}
 <p className="text-xs text-gray-600 text-center pt-2">
 Profile data is saved on the host's PC running the server{serverHost().local ? ' (this device)' : ` (${serverHost().host})`}
 </p>
 </div>
 )}

 {/* ==================== PREFERENCES TAB ==================== */}
 {activeTab === 'preferences' && (
 <div key="tab-preferences"className="space-y-5 animate-fade-in">
 {/* Auto-Update toggle (Electron only) */}
 {typeof window !== 'undefined' && !!(window as any).electronAPI?.isElectron && (
 <div className="space-y-3">
 <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
 <ArrowUpCircle size={16} className="text-[#4a9988]"/>
 Auto-Update
 </label>
 <div
 className={`flex items-center justify-between px-4 py-3 rounded-xl cursor-pointer transition-all duration-200 ${
 autoUpdate
 ? 'bg-emerald-900/20 border border-emerald-800/40'
 : 'bg-gray-800/50 border border-gray-800 hover:bg-gray-800'
 }`}
 onClick={async () => {
 const next = !autoUpdate;
 setAutoUpdate(next);
 localStorage.setItem(AUTO_UPDATE_KEY, String(next));
 // Also persist to the main process via IPC
 try {
 const api = (window as any).electronAPI;
 if (api?.setUpdatePreference) {
 await api.setUpdatePreference(next);
 }
 } catch {}
 }}
 >
 <div className="flex items-center gap-3">
 <div className={`p-1.5 rounded-lg ${autoUpdate ? 'bg-emerald-700/30' : 'bg-gray-700/50'}`}>
 <ArrowUpCircle size={18} className={autoUpdate ? 'text-[#4a9988]' : 'text-gray-400'} />
 </div>
 <div>
 <p className="text-sm font-medium text-white">
 {autoUpdate ? 'Enabled' : 'Disabled'}
 </p>
 <p className="text-xs text-gray-500 mt-0.5">
 {autoUpdate
 ? 'Automatically check for updates on startup'
 : 'No update checks until re-enabled'}
 </p>
 </div>
 </div>
 <div
 className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
 autoUpdate ? 'bg-emerald-600' : 'bg-gray-700'
 }`}
 >
 <div
 className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${
 autoUpdate ? 'translate-x-5' : 'translate-x-0'
 }`}
 />
 </div>
 </div>
 </div>
 )}

 {/* Thinking mode — always visible; grayed out when model lacks support */}
 <div className={`space-y-3 ${thinkingSupported === false ? 'opacity-50' : ''}`}>
 <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
 <Brain size={16} className="text-[#7b9fc6]"/>
 Thinking Mode
 {thinkingSupported === false && <span className="text-[10px] text-gray-600 ml-1">(not supported by model)</span>}
 </label>
 <div
 className={`flex items-center justify-between px-4 py-3 rounded-xl transition-all duration-200 ${
 thinkingSupported === false
 ? 'bg-gray-800/30 border border-gray-900 cursor-not-allowed'
 : thinkingEnabled
 ? 'bg-purple-900/20 border border-purple-800/40 cursor-pointer'
 : 'bg-gray-800/50 border border-gray-800 hover:bg-gray-800 cursor-pointer'
 }`}
 onClick={thinkingSupported !== false ? onToggleThinking : undefined}
 >
 <div className="flex items-center gap-3">
 <div className={`p-1.5 rounded-lg ${thinkingEnabled ? 'bg-purple-700/30' : 'bg-gray-700/50'}`}>
 <Brain size={18} className={thinkingEnabled ? 'text-[#7b9fc6]' : 'text-gray-400'} />
 </div>
 <div>
 <p className="text-sm font-medium text-white">
 {thinkingEnabled ? 'Auto' : 'Off'}
 </p>
 <p className="text-xs text-gray-500 mt-0.5">
 {thinkingSupported === false
 ? 'This model does not support thinking mode'
 : thinkingEnabled
 ? 'Automatically thinks only when a question needs reasoning — math, logic, analysis'
 : 'Never thinks — always fast, direct answers'}
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

 {/* Auto-title toggle */}
 <div className="space-y-3">
 <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
 <Sparkles size={16} className="text-[#4a9988]"/>
 Auto-Title
 </label>
 <div
 className={`flex items-center justify-between px-4 py-3 rounded-xl cursor-pointer transition-all duration-200 ${
 autoTitle
 ? 'bg-emerald-900/20 border border-emerald-800/40'
 : 'bg-gray-800/50 border border-gray-800 hover:bg-gray-800'
 }`}
 onClick={() => {
 const next = !autoTitle;
 setAutoTitle(next);
 localStorage.setItem('ai-chat:autoTitle', String(next));
 }}
 >
 <div className="flex items-center gap-3">
 <div className={`p-1.5 rounded-lg ${autoTitle ? 'bg-emerald-700/30' : 'bg-gray-700/50'}`}>
 <Sparkles size={18} className={autoTitle ? 'text-[#4a9988]' : 'text-gray-400'} />
 </div>
 <div>
 <p className="text-sm font-medium text-white">
 {autoTitle ? 'On' : 'Off'}
 </p>
 <p className="text-xs text-gray-500 mt-0.5">
 {autoTitle
 ? 'AI generates titles from first message'
 : 'Manual titles only'}
 </p>
 </div>
 </div>
 <div
 className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
 autoTitle ? 'bg-emerald-600' : 'bg-gray-700'
 }`}
 >
 <div
 className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${
 autoTitle ? 'translate-x-5' : 'translate-x-0'
 }`}
 />
 </div>
 </div>
 </div>

 {/* System Prompt */}
 <div className="space-y-3 pt-1">
 <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
 <Quote size={16} className="text-[#b8966a]"/>
 System Prompt
 </label>
 <p className="text-xs text-gray-500 leading-relaxed">
 Custom instructions the AI follows in every chat. Set its persona, behavior, or rules.
 </p>
 <div className="relative">
 <textarea
 value={systemPrompt}
 onChange={(e) => saveSystemPrompt(e.target.value)}
 placeholder="You are a helpful AI assistant. Be concise and friendly..."
 rows={4}
 maxLength={2000}
 className="w-full bg-gray-800 border border-gray-700 rounded-xl text-sm text-white placeholder-gray-500 p-3 outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600/30 transition-all resize-none"
 />
 <div className="flex items-center justify-between mt-1.5 px-1">
 <span className="text-xs text-gray-600">
 {systemPrompt.length} / 2000 characters
 </span>
 {systemPromptSaved && (
 <span className="text-xs text-[#4a9988] flex items-center gap-1">
 <Check size={10} /> Saved
 </span>
 )}
 {systemPrompt && (
 <button
 onClick={() => saveSystemPrompt('')}
 className="text-xs text-gray-500 hover:text-[#c44] transition-colors"
 >
 Clear
 </button>
 )}
 </div>
 </div>
 </div>

 {/* Advanced Settings */}
 <div className="border-t border-gray-800 pt-3"/>
 <button
 onClick={() => setShowAdvanced(!showAdvanced)}
 className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-gray-800/30 border border-dashed border-gray-700 hover:border-gray-600 rounded-xl text-xs text-gray-400 hover:text-gray-200 transition-all"
 >
 <Sliders size={12} />
 {showAdvanced ? 'Hide' : 'Show'} Advanced Parameters
 </button>

 {showAdvanced && (
 <div className="space-y-4 animate-fade-in">
 {/* Temperature */}
 <div className="space-y-2">
 <div className="flex items-center justify-between">
 <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
 <Thermometer size={14} className="text-orange-400"/>
 Temperature
 </label>
 <span className="text-xs text-gray-500 tabular-nums w-10 text-right">{temperature.toFixed(1)}</span>
 </div>
 <input
 type="range"
 min="0"
 max="2"
 step="0.1"
 value={temperature}
 onChange={(e) => {
 const val = parseFloat(e.target.value);
 setTemperature(val);
 localStorage.setItem('ai-chat:temperature', String(val));
 }}
 className="w-full h-1.5 accent-orange-500 cursor-pointer rounded-full appearance-none bg-gray-700"
 />
 <div className="flex justify-between text-[10px] text-gray-600">
 <span>Precise (0)</span>
 <span>Creative (2)</span>
 </div>
 </div>

 {/* Top P */}
 <div className="space-y-2">
 <div className="flex items-center justify-between">
 <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
 <Gauge size={14} className="text-[#7b9fc6]"/>
 Top P
 </label>
 <span className="text-xs text-gray-500 tabular-nums w-10 text-right">{topP.toFixed(2)}</span>
 </div>
 <input
 type="range"
 min="0"
 max="1"
 step="0.05"
 value={topP}
 onChange={(e) => {
 const val = parseFloat(e.target.value);
 setTopP(val);
 localStorage.setItem('ai-chat:top_p', String(val));
 }}
 className="w-full h-1.5 accent-blue-500 cursor-pointer rounded-full appearance-none bg-gray-700"
 />
 <div className="flex justify-between text-[10px] text-gray-600">
 <span>Focused (0)</span>
 <span>Diverse (1)</span>
 </div>
 </div>

 {/* Max Tokens */}
 <div className="space-y-2">
 <div className="flex items-center justify-between">
 <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
 <AlignLeft size={14} className="text-[#7b9fc6]"/>
 Max Tokens
 </label>
 <span className="text-xs text-gray-500 tabular-nums">{maxTokens >= 8192 ? 'Unlimited' : maxTokens}</span>
 </div>
 <input
 type="range"
 min="256"
 max="8192"
 step="256"
 value={maxTokens}
 onChange={(e) => {
 const val = parseInt(e.target.value);
 setMaxTokens(val);
 localStorage.setItem('ai-chat:maxTokens', String(val));
 }}
 className="w-full h-1.5 accent-purple-500 cursor-pointer rounded-full appearance-none bg-gray-700"
 />
 <div className="flex justify-between text-[10px] text-gray-600">
 <span>256</span>
 <span>8192</span>
 </div>
 </div>
 </div>
 )}
 </div>
 )}

 {/* ==================== APPEARANCE TAB ==================== */}
 {activeTab === 'appearance' && (
 <div key="tab-appearance"className="space-y-6 animate-fade-in">
 <div className="space-y-3">
 <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
 {theme === 'dark' ? <Moon size={16} className="text-[#7b9fc6]"/> : <Sun size={16} className="text-amber-500"/>}
 Theme
 </label>

 <div className="grid grid-cols-2 gap-3">
 {/* Dark mode card */}
 <div
 onClick={() => { if (theme !== 'dark') onToggleTheme(); }}
 className={`relative flex flex-col items-center gap-3 p-6 rounded-xl cursor-pointer transition-all duration-200 border-2 ${
 theme === 'dark'
 ? 'border-blue-500 bg-[#0e1a28] '
 : 'border-gray-800 bg-gray-800/30 hover:bg-gray-800/50 hover:border-gray-700'
 }`}
 >
 {theme === 'dark' && (
 <div className="absolute top-2 right-2 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
 <Check size={12} className="text-white"/>
 </div>
 )}
 <div className={`p-3 rounded-xl ${theme === 'dark' ? 'bg-blue-700/30' : 'bg-gray-700/50'}`}>
 <Moon size={28} className={theme === 'dark' ? 'text-[#7b9fc6]' : 'text-gray-400'} />
 </div>
 <div className="text-center">
 <p className="text-sm font-medium text-white">Dark Mode</p>
 <p className="text-xs text-gray-500 mt-1">Easy on the eyes,<br />great for low light</p>
 </div>
 </div>

 {/* Light mode card */}
 <div
 onClick={() => { if (theme !== 'light') onToggleTheme(); }}
 className={`relative flex flex-col items-center gap-3 p-6 rounded-xl cursor-pointer transition-all duration-200 border-2 ${
 theme === 'light'
 ? 'border-[#b8966a] bg-[#1a1610] '
 : 'border-gray-800 bg-gray-800/30 hover:bg-gray-800/50 hover:border-gray-700'
 }`}
 >
 {theme === 'light' && (
 <div className="absolute top-2 right-2 w-5 h-5 bg-[#b8966a] rounded-full flex items-center justify-center">
 <Check size={12} className="text-white"/>
 </div>
 )}
 <div className={`p-3 rounded-xl ${theme === 'light' ? 'bg-amber-700/30' : 'bg-gray-700/50'}`}>
 <Sun size={28} className={theme === 'light' ? 'text-amber-500' : 'text-gray-400'} />
 </div>
 <div className="text-center">
 <p className="text-sm font-medium text-white">Light Mode</p>
 <p className="text-xs text-gray-500 mt-1">Bright and clean,<br />great for daytime</p>
 </div>
 </div>
 </div>
 </div>
 </div>
 )}

 {/* ==================== MEMORY TAB ==================== */}
 {activeTab === 'memory' && (
 <div key="tab-memory"className="space-y-4 animate-fade-in">
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
 <Brain size={18} className={memoryEnabled ? 'text-[#4a9988]' : 'text-gray-400'} />
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

 {/* Memory info badge */}
 {memoryEnabled && Object.keys(memoryCategories).length === 0 && (
 <p className="text-xs text-gray-500 text-center py-3 bg-gray-800/20 rounded-xl border border-dashed border-gray-700">
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
 <BookOpen size={14} className="text-[#7b9fc6]"/>
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
 onRemoveMemoryCategory(category);
 toast('success', `Category"${category}"deleted`);
 }}
 className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-[#c44] transition-colors"
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
 className="p-1 bg-[#2a3a52] hover:bg-[#345070] rounded text-white transition-colors"
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
 className="p-0.5 hover:bg-gray-700 rounded text-gray-500 hover:text-[#c44]"
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
 className="p-2 bg-[#2a3a52] hover:bg-[#345070] rounded-lg text-white transition-colors"
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
 onResetMemory();
 toast('info', 'Memory cleared');
 }}
 className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-red-900/10 border border-red-900/30 hover:bg-red-900/20 rounded-xl text-xs text-[#c44] hover:text-[#d66] transition-all"
 >
 <RefreshCw size={12} />
 Clear All Memory
 </button>
 )}
 </div>
 )}

 {/* ==================== ACCOUNT TAB ==================== */}
 {activeTab === 'account' && (
 <div key="tab-account"className="space-y-4 animate-fade-in">
 <div className="space-y-3">
 <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
 <Shield size={16} className="text-gray-500"/>
 Account
 </label>

 {/* App version (Electron only) */}
 {appVersion && (
 <div className="px-4 py-3 bg-gray-800/30 border border-gray-800 rounded-xl space-y-1">
 <p className="text-xs text-gray-500">App Version</p>
 <p className="text-sm font-mono text-white flex items-center gap-2">
 <Package size={14} className="text-[#7b9fc6]"/>
 v{appVersion}
 </p>
 </div>
 )}

 {/* User info card */}
 <div className="px-4 py-4 bg-gray-800/30 border border-gray-800 rounded-xl space-y-3">
 <div className="flex items-center justify-between">
 <span className="text-xs text-gray-500">User ID</span>
 <button
 onClick={copyId}
 className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded-lg transition-colors"
 >
 {copied ? (
 <>
 <Check size={12} className="text-[#4a9988]"/>
 <span className="text-[#4a9988]">Copied</span>
 </>
 ) : (
 <>
 <Copy size={12} />
 <span>Copy</span>
 </>
 )}
 </button>
 </div>
 <code className="text-xs text-gray-400 font-mono break-all select-all bg-gray-900/50 block p-2 rounded-lg">
 {profile.id}
 </code>
 </div>

 {/* Device info */}
 <div className="px-4 py-3 bg-gray-800/30 border border-gray-800 rounded-xl space-y-1">
 <p className="text-xs text-gray-500">User Name</p>
 <p className="text-sm text-white">{profile.name}</p>
 </div>

 <div className="px-4 py-3 bg-gray-800/30 border border-gray-800 rounded-xl space-y-1">
 <p className="text-xs text-gray-500">Data Storage</p>
 <p className="text-sm text-white">
 {serverHost().local ? "Host's PC (this device)" : `Host's PC (${serverHost().host})`}
 </p>
 <p className="text-xs text-gray-500 mt-1 leading-relaxed">
 Conversations, accounts, memory & settings are saved on the host's PC running the Kasalix
 server — nothing is sent to any external service. Only your sign-in session stays
 on this device.
 </p>
 </div>
 </div>

 {/* Check for Updates (Electron only) */}
 {typeof window !== 'undefined' && !!(window as any).electronAPI?.isElectron && (
 <>
 <div className="border-t border-gray-800 pt-3"/>
 <button
 onClick={async () => {
 setCheckingUpdates(true);
 try {
 const electronApi = (window as any).electronAPI;
 const result = await electronApi.checkForUpdates();
 if (result?.available) {
 toast('success', `Update v${result.version} available! Check the banner at the top.`);
 } else if (result?.error) {
 // Show the actual error instead of hiding it
 const errMsg = result.error.length > 80 ? result.error.slice(0, 80) + '...' : result.error;
 toast('error', `Update check failed: ${errMsg}`);        } else if (result?.latestVersion && result.latestVersion !== appVersion) {
          // This build is NEWER than the latest GitHub release (dev build ahead
          // of the last published version) — informational, not a problem.
          toast('info', `You're on v${appVersion} — GitHub's latest release is v${result.latestVersion}, so this build is newer.`);
        } else if (result?.latestVersion) {
          toast('info', `Already up to date (v${result.currentVersion || appVersion}). GitHub also has v${result.latestVersion}.`);
 } else {
 toast('info', `You're up to date (v${appVersion || '?'}).`);
 }
 } catch (e) {      toast('error', 'Update check failed. Could not reach GitHub.');
 }
 setCheckingUpdates(false);
 }}
 disabled={checkingUpdates}
 className="w-full flex items-center gap-3 px-4 py-3 bg-emerald-900/10 border border-emerald-900/30 hover:bg-emerald-900/20 hover:border-[#1a3a33] rounded-xl transition-all duration-200 group disabled:opacity-50"
 >
 <div className="p-1.5 bg-emerald-900/30 rounded-lg group-hover:bg-emerald-900/40 transition-colors">
 {checkingUpdates ? (
 <RefreshCw size={16} className="text-[#4a9988] animate-spin"/>
 ) : (
 <Download size={16} className="text-[#4a9988]"/>
 )}
 </div>
 <div className="text-left flex-1">
 <p className="text-sm font-medium text-[#6ab5a5] group-hover:text-emerald-200 transition-colors">
 {checkingUpdates ? 'Checking...' : 'Check for Updates'}
 </p>
 <p className="text-xs text-gray-500">
 {checkingUpdates      ? 'Checking GitHub...'
 : appVersion ? `Currently on v${appVersion}` : 'See if a new version is available'}
 </p>
 </div>
 <Download size={16} className="text-emerald-500/50 group-hover:text-[#4a9988] transition-colors"/>
 </button>
 </>
 )}

 {/* Switch user */}
 <div className="border-t border-gray-800 pt-3"/>
 <button
 onClick={handleSwitch}
 className="w-full flex items-center gap-3 px-4 py-3 bg-red-900/10 border border-red-900/30 hover:bg-red-900/20 hover:border-[#5a3030] rounded-xl transition-all duration-200 group"
 >
 <div className="p-1.5 bg-red-900/30 rounded-lg group-hover:bg-red-900/40 transition-colors">
 <LogOut size={16} className="text-[#c44]"/>
 </div>
 <div className="text-left flex-1">
 <p className="text-sm font-medium text-[#d66] group-hover:text-red-200 transition-colors">Switch User</p>
 <p className="text-xs text-gray-500">Return to the welcome screen</p>
 </div>
 <LogOut size={16} className="text-red-500/50 group-hover:text-[#c44] transition-colors"/>
 </button>

 <p className="text-xs text-gray-600 text-center pt-2">
 Your data is saved on the host's PC running the server — nothing is sent to any external service
 </p>
 </div>
 )}
 </>
 )}

 {/* ==================== AGENT SECTION ==================== */}
 {section === 'koding' && (
 <div key="section-koding" className="space-y-5 animate-fade-in">
 <div className="flex items-center gap-2.5">
 <div className="p-2 bg-emerald-600/20 rounded-xl">
 <Bot size={18} className="text-[#4a9988]"/>
 </div>
 <div>
 <p className="text-sm font-medium text-white">Koding</p>
 <p className="text-xs text-gray-500 mt-0.5">AI coding agent — auto-apply is always on</p>
 </div>
 </div>

 {/* Rules / memory note */}
 <div className="px-4 py-3 bg-gray-800/30 border border-gray-800 rounded-xl">
 <p className="text-xs text-gray-500 leading-relaxed">
 <span className="text-gray-300 font-medium">Good to know:</span> your rules in{' '}
 <code className="text-gray-400 font-mono">.agent-rules.md</code> are read-only for the AI — it
 can never change them. The AI's own notes are saved to{' '}
 <code className="text-gray-400 font-mono">.agent-memory.md</code>, which is lower priority than
 your rules.
 </p>
 </div>

 {/* Hide preview window (Electron only) */}
 {typeof window !== 'undefined' && !!(window as any).electronAPI?.isElectron && (
 <div
 className={`flex items-center justify-between px-4 py-3 rounded-xl cursor-pointer transition-all duration-200 ${
 previewHidden
 ? 'bg-emerald-900/20 border border-emerald-800/40'
 : 'bg-gray-800/50 border border-gray-800 hover:bg-gray-800'
 }`}
 onClick={togglePreviewHidden}
 >
 <div className="flex items-center gap-3">
 <div className={`p-1.5 rounded-lg ${previewHidden ? 'bg-emerald-700/30' : 'bg-gray-700/50'}`}>
 <MonitorOff size={16} className={previewHidden ? 'text-[#4a9988]' : 'text-gray-400'} />
 </div>
 <div>
 <p className="text-sm font-medium text-gray-200">Hide preview window</p>
 <p className="text-xs text-gray-500 mt-0.5">
 Agent still verifies its web work (screenshots, console, JS checks) — nothing pops up on your screen
 </p>
 </div>
 </div>
 <div className={`w-10 h-6 rounded-full p-1 transition-colors duration-200 ${previewHidden ? 'bg-emerald-600' : 'bg-gray-700'}`}>
 <div className={`w-4 h-4 rounded-full bg-white transition-transform duration-200 ${previewHidden ? 'translate-x-4' : 'translate-x-0'}`} />
 </div>
 </div>
 )}
 </div>
 )}
 </div>
 </div>
 </div>
 );
}
