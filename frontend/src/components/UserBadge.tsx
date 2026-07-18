import { LogOut, Copy, Check, Settings } from 'lucide-react';
import { useState } from 'react';
import type { UserProfile } from '../types';

interface Props {
  profile: UserProfile;
  onSwitch: () => void;
  onSettings?: () => void;
}

export function UserBadge({ profile, onSwitch, onSettings }: Props) {
  const [copied, setCopied] = useState(false);

  const copyId = async () => {
    await navigator.clipboard.writeText(profile.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="p-3 border-t border-gray-800">
      <div className="flex items-center gap-2 mb-2">
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold text-white flex-shrink-0"
          style={{ backgroundColor: profile.color }}
          title={profile.name}
        >
          {profile.name.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{profile.name}</div>
          <div className="text-xs text-gray-500">Local user</div>
        </div>
        <div className="flex items-center gap-1">
          {onSettings && (
            <button
              onClick={onSettings}
              className="p-1.5 hover:bg-gray-800 rounded text-gray-400 hover:text-gray-200 transition-colors"
              title="User settings"
            >
              <Settings size={14} />
            </button>
          )}
          <button
            onClick={() => {
              if (confirm('Switch user? You will return to the welcome screen.')) onSwitch();
            }}
            className="p-1.5 hover:bg-gray-800 rounded text-gray-400 hover:text-red-400 transition-colors"
            title="Switch user"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>

      {/* Quick user ID display */}
      <button
        onClick={copyId}
        className="w-full flex items-center gap-2 px-2 py-1.5 bg-gray-800/50 hover:bg-gray-800 rounded text-left transition-colors group"
        title="Click to copy user ID"
      >
        <span className="text-xs text-gray-500 flex-shrink-0">ID:</span>
        <code className="text-xs text-gray-300 font-mono truncate flex-1">
          {profile.id}
        </code>
        {copied ? (
          <Check size={12} className="text-emerald-400 flex-shrink-0" />
        ) : (
          <Copy size={12} className="text-gray-500 group-hover:text-gray-300 flex-shrink-0" />
        )}
      </button>
    </div>
  );
}
