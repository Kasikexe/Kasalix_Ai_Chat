import { useState } from 'react';
import { LogOut } from 'lucide-react';
import type { UserProfile } from '../types';

interface Props {
  profile: UserProfile;
  onSwitch: () => void;
}

export function UserBadge({ profile, onSwitch }: Props) {
  return (
    <div className="p-3 border-t border-gray-800 flex items-center gap-2">
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
      <button
        onClick={() => {
          if (confirm('Switch user? You will return to the welcome screen.')) onSwitch();
        }}
        className="p-1.5 hover:bg-gray-800 rounded text-gray-400"
        title="Switch user"
      >
        <LogOut size={14} />
      </button>
    </div>
  );
}
