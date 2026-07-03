import { Menu, Settings, Lock } from 'lucide-react';
import { ModelSelector } from './ModelSelector';
import type { OllamaModel } from '../types';

interface HeaderProps {
  models: OllamaModel[];
  selectedModel: string;
  onModelChange: (model: string) => void;
  onMenuClick: () => void;
  onSettingsClick: () => void;
  isAdmin: boolean;
  getModelStatus: (name: string) => 'available' | 'hidden' | 'unavailable';
}

export function Header({
  models, selectedModel, onModelChange, onMenuClick,
  onSettingsClick, isAdmin, getModelStatus,
}: HeaderProps) {
  return (
    <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-20">
      <div className="flex items-center justify-between px-3 md:px-4 py-3 gap-2">
        <button
          onClick={onMenuClick}
          className="md:hidden p-1.5 hover:bg-gray-800 rounded-lg text-gray-300"
          aria-label="Open menu"
        >
          <Menu size={20} />
        </button>
        <h1 className="md:hidden text-sm font-medium text-gray-300">AI Chat</h1>
        <div className="flex-1 md:flex-none" />

        <button
          onClick={onSettingsClick}
          className="p-2 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-200 transition-colors"
          aria-label="Settings"
          title={isAdmin ? 'Settings' : 'Settings (locked)'}
        >
          {isAdmin ? <Settings size={18} /> : <Lock size={18} />}
        </button>

        <ModelSelector
          models={models}
          selected={selectedModel}
          onChange={onModelChange}
          getModelStatus={getModelStatus}
        />
      </div>
    </header>
  );
}
