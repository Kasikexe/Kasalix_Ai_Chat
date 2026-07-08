import { useState, useCallback, useMemo, memo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { Check, Copy, Download, User, Bot, FileCode, RefreshCw, Pencil, X, Save, FilePlus2 } from 'lucide-react';
import type { Message as MessageType } from '../types';

const languageExtensions: Record<string, string> = {
  javascript: '.js',
  js: '.js',
  typescript: '.ts',
  ts: '.ts',
  jsx: '.jsx',
  tsx: '.tsx',
  python: '.py',
  py: '.py',
  html: '.html',
  css: '.css',
  scss: '.scss',
  json: '.json',
  yaml: '.yml',
  yml: '.yml',
  markdown: '.md',
  md: '.md',
  bash: '.sh',
  shell: '.sh',
  sh: '.sh',
  sql: '.sql',
  go: '.go',
  rust: '.rs',
  rs: '.rs',
  c: '.c',
  cpp: '.cpp',
  'c++': '.cpp',
  java: '.java',
  php: '.php',
  ruby: '.rb',
  rb: '.rb',
  dockerfile: '.Dockerfile',
  xml: '.xml',
  svg: '.svg',
  powershell: '.ps1',
  pgsql: '.sql',
  postgresql: '.sql',
  graphql: '.graphql',
  gql: '.graphql',
  solidity: '.sol',
  kotlin: '.kt',
  swift: '.swift',
};

const FILE_PATH_RE = /^(?:\/\/|#|;|%|--|\/\*|<!--)\s*([^\s]+?\.[a-zA-Z]\w*)\s*(?:\*\/|-->)?$/;

const CodeBlock = memo(function CodeBlock({ children, className, onApplyCode }: { children: string; className?: string; onApplyCode?: (filePath: string, content: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  // Ensure children is a string (guard against React nodes during streaming edge cases)
  const safeChildren = typeof children === 'string' ? children : '';
  const language = className?.replace('language-', '') || '';
  const extension = language ? languageExtensions[language] || `.${language}` : '.txt';

  // Detect file path in first line
  const { detectedPath, codeContent } = useMemo(() => {
    const lines = safeChildren.split('\n');
    const firstLine = lines[0]?.trim() || '';
    const match = firstLine.match(FILE_PATH_RE);
    if (match) {
      return {
        detectedPath: match[1],
        codeContent: lines.slice(1).join('\n').trimStart(),
      };
    }
    return { detectedPath: null, codeContent: safeChildren };
  }, [safeChildren]);

  const displayContent = detectedPath ? codeContent : safeChildren;

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(displayContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [displayContent]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([displayContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `code${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 1500);
  }, [displayContent, extension]);

  return (
    <div className="group relative not-prose">
      <div className="flex items-center justify-between px-4 py-1.5 bg-gray-800/80 text-xs text-gray-400 rounded-t-lg border-b border-gray-700/50">
        <div className="flex items-center gap-1.5">
          <FileCode size={12} />
          <span>{detectedPath || language || 'code'}</span>
        </div>
        <div className="flex items-center gap-1">
          {detectedPath && onApplyCode && (
            <button
              onClick={() => onApplyCode(detectedPath!, displayContent)}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-all duration-150 hover:bg-purple-900/40 hover:text-purple-300 text-purple-400 active:scale-95"
              title={`Apply to ${detectedPath}`}
            >
              <FilePlus2 size={12} />
              Apply
            </button>
          )}
          <button
            onClick={handleDownload}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-all duration-150 opacity-0 group-hover:opacity-100 hover:bg-gray-700/50 active:scale-95"
            title={downloaded ? 'Downloaded!' : 'Download code'}
          >
            {downloaded ? <Check size={12} className="text-emerald-400" /> : <Download size={12} />}
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-all duration-150 opacity-0 group-hover:opacity-100 hover:bg-gray-700/50 active:scale-95"
          >
            {copied ? (
              <>
                <Check size={12} className="text-emerald-400" />
                <span className="text-emerald-400">Copied!</span>
              </>
            ) : (
              <>
                <Copy size={12} />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      </div>
      <pre className="!mt-0 !rounded-t-none">
        <code className={className}>{displayContent}</code>
      </pre>
    </div>
  );
});

interface Props {
  message: MessageType;
  isStreaming?: boolean;
  stage?: string;
  index?: number;
  onEdit?: (index: number, newContent: string) => void;
  onRegenerate?: () => void;
  isLastAssistant?: boolean;
  onApplyCode?: (filePath: string, codeContent: string) => void;
}

const stageLabels: Record<string, string> = {
  'vision': '🔍 Analyzing image',
  'reading': '📂 Reading workspace',
  'writing': '✏️ Writing files',
  'code': '💻 Writing code',
  'editing': '✏️ Editing files',
  'summary': '✨ Polishing response',
  'chat': '💬 Thinking',
};

function getStageLabel(stage?: string): string | null {
  if (!stage) return null;
  for (const [key, label] of Object.entries(stageLabels)) {
    if (stage.startsWith(key)) return label;
  }
  return '⚙️ Processing';
}

export const Message = memo(function Message({ message, isStreaming, stage, index, onEdit, onRegenerate, isLastAssistant, onApplyCode }: Props) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const isUser = message.role === 'user';
  const stageLabel = getStageLabel(stage);

  const copy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const startEdit = () => {
    setEditValue(message.content.replace(/\[image:[^\]]+\]/g, '').trim());
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditValue('');
  };

  const saveEdit = () => {
    if (editValue.trim() && index !== undefined && onEdit) {
      onEdit(index, editValue.trim());
    }
    setEditing(false);
  };

  // Strip the [image:...] tag from display
  const displayContent = message.content.replace(/\[image:[^\]]+\]/g, '').trim();

  // Skip expensive rehypeHighlight during streaming — only syntax-highlight after completion
  const rehypePlugins = useMemo(
    () => (isStreaming ? [] : [rehypeHighlight]),
    [isStreaming]
  );

  // Memoize the components object so inline functions don't break memoization
  const markdownComponents = useMemo(() => ({
    pre: ({ children }: { children?: ReactNode }) => {
      if (children && typeof children === 'object' && 'type' in children && (children as any).type === 'code') {
        const codeChild = children as any;
        return <CodeBlock className={codeChild.props?.className} onApplyCode={onApplyCode}>{codeChild.props?.children}</CodeBlock>;
      }
      return <pre>{children}</pre>;
    },
  }), [onApplyCode]);

  return (
    <div className={`flex gap-3 px-4 py-6 animate-fade-in ${isUser ? '' : 'bg-gray-900/40'}`}>
      <div className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center">
        {isUser ? (
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
            <User size={16} className="text-white" />
          </div>
        ) : (
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
            <Bot size={16} className="text-white" />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="font-semibold text-sm mb-1 text-gray-200 flex items-center gap-2">
          <span>{isUser ? 'You' : 'Assistant'}</span>
          {isUser && !editing && index !== undefined && onEdit && !isStreaming && (
            <button
              onClick={startEdit}
              className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-700 rounded text-gray-500 hover:text-gray-300 transition-all"
              title="Edit message"
            >
              <Pencil size={12} />
            </button>
          )}
        </div>

        {isStreaming && stageLabel && (
          <div className="mb-2 inline-flex items-center gap-1.5 text-xs text-gray-400">
            <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
            <span>{stageLabel}</span>
          </div>
        )}

        {/* Show image attachment for user messages */}
        {isUser && (message.content.includes('[image:data:image') || message.content.includes('[image]')) && (
          <div className="mb-2 text-xs text-gray-500 italic">
            📷 Image attached
          </div>
        )}

        {editing ? (
          <div className="space-y-2">
            <textarea
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  saveEdit();
                }
                if (e.key === 'Escape') cancelEdit();
              }}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 p-3 outline-none focus:border-gray-600 resize-none min-h-[80px]"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={saveEdit}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors"
              >
                <Save size={14} />
                Save & re-send
              </button>
              <button
                onClick={cancelEdit}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium rounded-lg transition-colors border border-gray-700"
              >
                <X size={14} />
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none break-words">
            {displayContent ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={rehypePlugins}
                components={markdownComponents}
              >
                {displayContent}
              </ReactMarkdown>
            ) : isStreaming ? (
              <span className="inline-flex gap-1 items-center text-gray-400">
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse-soft" />
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse-soft" style={{ animationDelay: '0.2s' }} />
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse-soft" style={{ animationDelay: '0.4s' }} />
              </span>
            ) : null}
          </div>
        )}

        {!editing && (
          <div className="flex items-center gap-1 mt-2">
            {!isUser && displayContent && !isStreaming && (
              <button
                onClick={copy}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors px-1 py-0.5 rounded hover:bg-gray-800"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
            {!isUser && isLastAssistant && !isStreaming && displayContent && onRegenerate && (
              <button
                onClick={onRegenerate}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors px-1 py-0.5 rounded hover:bg-gray-800"
                title="Regenerate response"
              >
                <RefreshCw size={12} />
                Regenerate
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
