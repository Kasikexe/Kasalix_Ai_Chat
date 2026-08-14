import { useState, useRef, useEffect } from 'react';
import { Menu, Brain, Download, Smartphone, Wifi, Info, History, Bug, Lightbulb, BarChart3, MoreVertical } from 'lucide-react';
import { openExternal, NEW_ISSUE_URL, IDEAS_URL, REPO_URL } from '../utils/openExternal';
import type { Conversation } from '../types';
import { AboutModal } from './AboutModal';
import { ChangelogModal } from './ChangelogModal';
import { PollModal } from './PollModal';

interface HeaderProps {
  onMenuClick: () => void;
  thinkingEnabled: boolean;
  onToggleThinking: () => void;
  conversation?: Conversation | null;
  hideThinking?: boolean;
  /** False when the chat model can't do thinking — hides the toggle entirely */
  thinkingSupported?: boolean;
  /** Open the server-configuration screen (both desktop + mobile clients) */
  onConfigureServer?: () => void;
}

/** Inline GitHub mark (lucide-style) so the trigger works in every client. */
function GithubIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

export function Header({
  onMenuClick, thinkingEnabled, onToggleThinking, conversation, hideThinking, thinkingSupported, onConfigureServer
}: HeaderProps) {
  const [exportOpen, setExportOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
      if (feedbackRef.current && !feedbackRef.current.contains(e.target as Node)) {
        setFeedbackOpen(false);
      }
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
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
    <>
    <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-20">
      <div className="flex items-center justify-between px-3 md:px-4 py-3 gap-2">
        <button
          onClick={onMenuClick}
          className="md:hidden p-1.5 hover:bg-gray-800 rounded-lg text-gray-300"
          aria-label="Open menu"
        >
          <Menu size={20} />
        </button>
        <h1 className="md:hidden text-sm font-medium text-gray-300">Kasalix AI Chat</h1>
        <div className="flex-1" />

        {/* Export dropdown — desktop only (mobile: in the ⋯ menu) */}
        {conversation && conversation.messages.length > 0 && (
          <div ref={exportRef} className="relative hidden md:block">
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

        {/* Thinking mode toggle — hidden in agent mode or when the chat model has no thinking support */}
        {!hideThinking && thinkingSupported !== false && (
          <button
            onClick={onToggleThinking}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              thinkingEnabled
                ? 'bg-purple-900/40 text-purple-300 border border-purple-700'
                : 'bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700'
            }`}
            title={thinkingEnabled ? 'Thinking: Auto — activates only when a question needs reasoning' : 'Thinking: Off — always direct answers'}
          >
            <Brain size={14} />
            <span className="hidden sm:inline">
              {thinkingEnabled ? 'Auto' : 'Off'}
            </span>
          </button>
        )}

        {/* Download client apps button — desktop only (mobile: in the ⋯ menu) */}
        <a
          href="/download"
          className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors bg-blue-900/30 text-blue-300 border border-blue-700/50 hover:bg-blue-800/40"
          title="Download Android APK or Windows EXE"
        >
          <Smartphone size={14} />
          <span className="hidden sm:inline">Download</span>
        </a>

        {/* Feedback dropdown — desktop only (mobile: in the ⋯ menu) */}
        <div ref={feedbackRef} className="relative hidden md:block">
          <button
            onClick={() => setFeedbackOpen(!feedbackOpen)}
            className="p-2 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-200 transition-colors"
            title="Feedback — report a bug or suggest an idea"
            aria-label="Feedback"
            aria-expanded={feedbackOpen}
          >
            <GithubIcon />
          </button>
          {feedbackOpen && (
            <div className="absolute right-0 top-full mt-1 w-60 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1.5 z-50">
              <button
                onClick={() => { setFeedbackOpen(false); openExternal(NEW_ISSUE_URL); }}
                className="w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors group"
              >
                <span className="flex items-center gap-2 text-xs text-gray-300">
                  <Bug size={14} className="text-red-400 flex-shrink-0" />
                  Report a bug
                </span>
                <span className="block ml-6 mt-0.5 text-[10px] text-gray-600 group-hover:text-gray-500">
                  Open a GitHub issue
                </span>
              </button>
              <button
                onClick={() => { setFeedbackOpen(false); openExternal(IDEAS_URL); }}
                className="w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors group"
              >
                <span className="flex items-center gap-2 text-xs text-gray-300">
                  <Lightbulb size={14} className="text-amber-400 flex-shrink-0" />
                  Suggest an idea
                </span>
                <span className="block ml-6 mt-0.5 text-[10px] text-gray-600 group-hover:text-gray-500">
                  GitHub Discussions — Ideas
                </span>
              </button>
              <div className="my-1 border-t border-gray-700" />
              <button
                onClick={() => { setFeedbackOpen(false); openExternal(REPO_URL); }}
                className="w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors group"
              >
                <span className="flex items-center gap-2 text-xs text-gray-300">
                  <GithubIcon size={14} />
                  Visit repository
                </span>
                <span className="block ml-6 mt-0.5 text-[10px] text-gray-600 group-hover:text-gray-500">
                  {REPO_URL.replace('https://', '')}
                </span>
              </button>
            </div>
          )}
        </div>

        {/* Community Poll button — desktop only (mobile: in the ⋯ menu) */}
        <button
          onClick={() => setPollOpen(true)}
          className="hidden md:flex p-2 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-200 transition-colors"
          title="Community Poll — vote on what to build next"
          aria-label="Community Poll"
        >
          <BarChart3 size={18} />
        </button>

        {/* Changelog button — desktop only (mobile: in the ⋯ menu) */}
        <button
          onClick={() => setChangelogOpen(true)}
          className="hidden md:flex p-2 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-200 transition-colors"
          title="Changelog & release notes"
        >
          <History size={18} />
        </button>

        {/* About button — desktop only (mobile: in the ⋯ menu) */}
        <button
          onClick={() => setAboutOpen(true)}
          className="hidden md:flex p-2 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-200 transition-colors"
          title="About Kasalix AI Chat"
        >
          <Info size={18} />
        </button>

        {/* Change Server button — available in both desktop (Electron) and mobile (Capacitor) */}
        {onConfigureServer && (
          <button
            onClick={onConfigureServer}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors bg-amber-900/30 text-amber-300 border border-amber-700/50 hover:bg-amber-800/40"
            title="Change the server connection (address, http/https)"
          >
            <Wifi size={14} />
            <span className="hidden sm:inline">Server</span>
          </button>
        )}

        {/* More ⋯ menu — mobile only, holds the secondary actions that don't
            fit in one row on narrow screens */}
        <div ref={moreRef} className="relative md:hidden">
          <button
            onClick={() => setMoreOpen(!moreOpen)}
            className="p-2 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-200 transition-colors"
            title="More options"
            aria-label="More options"
            aria-expanded={moreOpen}
          >
            <MoreVertical size={18} />
          </button>
          {moreOpen && (
            <div className="absolute right-0 top-full mt-1 w-56 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1.5 z-50 max-h-[70vh] overflow-y-auto">
              {conversation && conversation.messages.length > 0 && (
                <>
                  <button
                    onClick={() => { setMoreOpen(false); formatMessages('markdown'); }}
                    className="w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors text-xs text-gray-300"
                  >
                    Export as Markdown
                  </button>
                  <button
                    onClick={() => { setMoreOpen(false); formatMessages('json'); }}
                    className="w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors text-xs text-gray-300"
                  >
                    Export as JSON
                  </button>
                  <div className="my-1 border-t border-gray-700" />
                </>
              )}
              <a
                href="/download"
                onClick={() => setMoreOpen(false)}
                className="flex items-center gap-2 w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors text-xs text-gray-300"
              >
                <Smartphone size={14} className="text-blue-400 flex-shrink-0" />
                Download apps
              </a>
              <button
                onClick={() => { setMoreOpen(false); openExternal(NEW_ISSUE_URL); }}
                className="flex items-center gap-2 w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors text-xs text-gray-300"
              >
                <Bug size={14} className="text-red-400 flex-shrink-0" />
                Report a bug
              </button>
              <button
                onClick={() => { setMoreOpen(false); openExternal(IDEAS_URL); }}
                className="flex items-center gap-2 w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors text-xs text-gray-300"
              >
                <Lightbulb size={14} className="text-amber-400 flex-shrink-0" />
                Suggest an idea
              </button>
              <button
                onClick={() => { setMoreOpen(false); openExternal(REPO_URL); }}
                className="flex items-center gap-2 w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors text-xs text-gray-300"
              >
                <GithubIcon size={14} />
                Visit repository
              </button>
              <div className="my-1 border-t border-gray-700" />
              <button
                onClick={() => { setMoreOpen(false); setPollOpen(true); }}
                className="flex items-center gap-2 w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors text-xs text-gray-300"
              >
                <BarChart3 size={14} className="text-purple-400 flex-shrink-0" />
                Community Poll
              </button>
              <button
                onClick={() => { setMoreOpen(false); setChangelogOpen(true); }}
                className="flex items-center gap-2 w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors text-xs text-gray-300"
              >
                <History size={14} className="text-gray-400 flex-shrink-0" />
                Changelog
              </button>
              <button
                onClick={() => { setMoreOpen(false); setAboutOpen(true); }}
                className="flex items-center gap-2 w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors text-xs text-gray-300"
              >
                <Info size={14} className="text-gray-400 flex-shrink-0" />
                About
              </button>
            </div>
          )}
        </div>

      </div>
    </header>

    {/* Modals must render OUTSIDE the <header> element: the header's
        backdrop-blur (backdrop-filter) makes it the containing block for
        position:fixed descendants, which would shrink the modal overlays
        to the header strip instead of the full viewport. */}
    <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    <ChangelogModal open={changelogOpen} onClose={() => setChangelogOpen(false)} />
    <PollModal open={pollOpen} onClose={() => setPollOpen(false)} />
    </>
  );
}
