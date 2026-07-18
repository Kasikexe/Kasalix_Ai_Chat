import { useState, useEffect, useRef } from 'react';
import {
  X, User, Palette, Copy, Check, Key, Brain,
  LogOut, Pencil, CheckCircle, AtSign, Shield, Sun, Moon,
} from 'lucide-react';
import type { UserProfile } from '../types';

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
}

export function UserSettingsModal({
  open, onClose, profile, onUpdate, onSwitch,
  thinkingEnabled, onToggleThinking,
  theme, onToggleTheme,
}: Props) {
  const [name, setName] = useState(profile.name);
  const [selectedColor, setSelectedColor] = useState(profile.color);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Reset state when profile changes or modal opens
  useEffect(() => {
    if (open) {
      setName(profile.name);
      setSelectedColor(profile.color);
      setIsEditing(false);
      setSaved(false);
    }
  }, [open, profile]);

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
