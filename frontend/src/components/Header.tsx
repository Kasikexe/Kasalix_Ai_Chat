import { Menu, Settings, Lock, Brain } from 'lucide-react';

interface HeaderProps {
  onMenuClick: () => void;
  onSettingsClick: () => void;
  isAdmin: boolean;
  thinkingEnabled: boolean;
  onToggleThinking: () => void;
}

export function Header({
  onMenuClick, onSettingsClick, isAdmin, thinkingEnabled, onToggleThinking
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
        <div className="flex-1" />

        {/* Thinking mode toggle */}
        <button
          onClick={onToggleThinking}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            thinkingEnabled
              ? 'bg-purple-900/40 text-purple-300 border border-purple-700'
              : 'bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700'
          }`}
          title={thinkingEnabled ? 'Thinking mode ON (slower, smarter)' : 'Thinking mode OFF (faster, direct)'}
        >
          <Brain size={14} />
          <span className="hidden sm:inline">
            {thinkingEnabled ? 'Thinking' : 'Fast'}
          </span>
        </button>

        <button
          onClick={onSettingsClick}
          className="p-2 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-200 transition-colors"
          aria-label="Settings"
          title={isAdmin ? 'Settings' : 'Settings (locked)'}
        >
          {isAdmin ? <Settings size={18} /> : <Lock size={18} />}
        </button>
      </div>
    </header>
  );
}
