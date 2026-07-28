import { useState, useRef, useEffect } from 'react';
import { Menu, Brain, Download, Sparkles, Lock, Wifi, Smartphone } from 'lucide-react';
import type { Conversation } from '../types';
import { isInCapacitor, clearServerUrl, getSavedServerUrl } from '../services/api';

interface HeaderProps {
  onMenuClick: () => void;
  onAdminClick: () => void;
  onSpeedTestClick?: () => void;
  isAdmin: boolean;
  thinkingEnabled: boolean;
  onToggleThinking: () => void;
  conversation?: Conversation | null;
  hideThinking?: boolean;
}

export function Header({
  onMenuClick, onAdminClick, onSpeedTestClick, isAdmin, thinkingEnabled, onToggleThinking, conversation, hideThinking
}: HeaderProps) {
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const formatMessages = (format: 'markdown' | 'json') => {
    if (!conversation) return;
    setExportOpen(false);

    let content: string;
    let filename: string;
    let mimeType: string;

    if (format === 'markdown') {
      const lines: string[] = [
        `# ${conversation.title}`,
        '',
        `*Exported on ${new Date().toLocaleString()}*`,
        '',
        '---',
        '',
      ];
      for (const msg of conversation.messages) {
        const role = msg.role === 'user' ? '👤 **You**' : '🤖 **Assistant**';
        const content = msg.content.replace(/\[image:[^\]]+\]/g, '[Image attached]');
        lines.push(`${role}:`);
        lines.push('');
        lines.push(content);
        lines.push('');
        lines.push('---');
        lines.push('');
      }
      content = lines.join('\n');
      filename = `${conversation.title.replace(/[^a-z0-9]/gi, '_')}.md`;
      mimeType = 'text/markdown';
    } else {
      const exportData = {
        title: conversation.title,
        model: conversation.model,
        exportedAt: new Date().toISOString(),
        messages: conversation.messages.map((m) => ({
          role: m.role,
          content: m.content.replace(/\[image:[^\]]+\]/g, '[Image attached]'),
          timestamp: m.timestamp,
        })),
      };
      content = JSON.stringify(exportData, null, 2);
      filename = `${conversation.title.replace(/[^a-z0-9]/gi, '_')}.json`;
      mimeType = 'application/json';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

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

        {/* Export dropdown */}
        {conversation && conversation.messages.length > 0 && (
          <div ref={exportRef} className="relative">
            <button
              onClick={() => setExportOpen(!exportOpen)}
              className="p-2 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-200 transition-colors"
              title="Export conversation"
            >
              <Download size={18} />
            </button>
            {exportOpen && (
              <div className="absolute right-0 top-full mt-1 w-44 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 z-50">
                <button
                  onClick={() => formatMessages('markdown')}
                  className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 transition-colors"
                >
                  Export as Markdown
                </button>
                <button
                  onClick={() => formatMessages('json')}
                  className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 transition-colors"
                >
                  Export as JSON
                </button>
              </div>
            )}
          </div>
        )}

        {/* Thinking mode toggle — hidden in agent mode */}
        {!hideThinking && (
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
        )}

        {/* Speed Test button — admin only */}
        {isAdmin && onSpeedTestClick && (
          <button
            onClick={onSpeedTestClick}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors bg-emerald-900/30 text-emerald-300 border border-emerald-700/50 hover:bg-emerald-800/40"
            title="Run performance speed tests"
          >
            <span className="text-[11px]">⚡</span>
            <span className="hidden sm:inline">Speed</span>
          </button>
        )}

        {/* Download APK button — visible to everyone (or only on mobile) */}
        <a
          href="/download"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors bg-blue-900/30 text-blue-300 border border-blue-700/50 hover:bg-blue-800/40"
          title="Download the Android APK"
        >
          <Smartphone size={14} />
          <span className="hidden sm:inline">Download</span>
        </a>

        {/* Change Server button — only in Capacitor (Android) mode */}
        {isInCapacitor() && getSavedServerUrl() && (
          <button
            onClick={() => {
              clearServerUrl();
              window.location.reload();
            }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors bg-amber-900/30 text-amber-300 border border-amber-700/50 hover:bg-amber-800/40"
            title="Change the server connection"
          >
            <Wifi size={14} />
            <span className="hidden sm:inline">Server</span>
          </button>
        )}

        <button
          onClick={onAdminClick}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            isAdmin
              ? 'bg-indigo-900/30 text-indigo-300 border border-indigo-700/50 hover:bg-indigo-800/40'
              : 'bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700'
          }`}
          title={isAdmin ? 'Assign models to different tasks' : 'Enter admin password to configure models'}
        >
          {isAdmin ? <Sparkles size={14} /> : <Lock size={14} />}
          <span className="hidden sm:inline">
            {isAdmin ? 'Models' : 'Admin'}
          </span>
        </button>
      </div>
    </header>
  );
}
