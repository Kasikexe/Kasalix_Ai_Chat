import { useState, useCallback, useMemo, useRef, memo, type ReactNode } from 'react';
import { useToast } from '../hooks/useToast';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { Check, Copy, Download, User, Bot, FileCode, RefreshCw, Pencil, X, Save, FilePlus2, Trash2, GitBranch, Code2, FileText, Layers, ImageIcon, ZoomIn, Brain, ChevronDown } from 'lucide-react';
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
const DELETE_PATH_RE = /^(?:\/\/|#|--)\s*DELETE:\s*([^\s]+)/i;
const EDIT_PATH_RE = /^(?:\/\/|#|--|;|%|<!--)\s*EDIT:\s*([^\s]+?)(?:\s*-->)?$/i;
const CODE_BLOCK_RE = /```(?:\w*)\n([\s\S]*?)```/g;

/**
 * Parse an EDIT code block: first line "// EDIT: path", then OLD: lines,
 * then a --- separator, then NEW: lines. Returns the old/new snippets.
 */
function parseEditBlock(block: string): { path: string; oldString: string; newString: string } | null {
  const lines = block.split('\n');
  const first = lines[0]?.trim() || '';
  const m = first.match(EDIT_PATH_RE);
  if (!m) return null;
  const path = m[1];

  // Find the OLD:/NEW: sections
  let oldStart = -1;
  let sep = -1;
  let newStart = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (oldStart === -1 && /^OLD:$/i.test(t)) { oldStart = i; continue; }
    if (oldStart !== -1 && sep === -1 && /^-{3,}$/.test(t)) { sep = i; continue; }
    if (sep !== -1 && /^NEW:$/i.test(t)) { newStart = i; break; }
  }
  if (oldStart === -1 || sep === -1 || newStart === -1) return null;

  const oldString = lines.slice(oldStart + 1, sep).join('\n').trim();
  const newString = lines.slice(newStart + 1).join('\n').trim();
  if (!oldString) return null;
  return { path, oldString, newString };
}

// Extract all code blocks with detected file paths (or EDIT blocks) from markdown
function extractApplicableFiles(content: string): { filePath: string; content: string; oldString?: string; newString?: string }[] {
  const result: { filePath: string; content: string; oldString?: string; newString?: string }[] = [];
  let match;
  while ((match = CODE_BLOCK_RE.exec(content)) !== null) {
    const block = match[1];
    const lines = block.split('\n');
    const firstLine = lines[0]?.trim() || '';

    // EDIT block
    const edit = parseEditBlock(block);
    if (edit) {
      result.push({ filePath: edit.path, content: edit.newString, oldString: edit.oldString, newString: edit.newString });
      continue;
    }

    const pathMatch = firstLine.match(FILE_PATH_RE);
    if (pathMatch) {
      const filePath = pathMatch[1];
      const codeContent = lines.slice(1).join('\n').trimStart();
      result.push({ filePath, content: codeContent });
    }
  }
  return result;
}

const CodeBlock = memo(function CodeBlock({ children, className, onApplyCode, onApplyEdit, onDeleteFile }: { children: string; className?: string; onApplyCode?: (filePath: string, content: string) => void; onApplyEdit?: (filePath: string, oldString: string, newString: string) => void; onDeleteFile?: (filePath: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [showPathInput, setShowPathInput] = useState(false);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  // Extract text content from React nodes (handles rehypeHighlight <span> elements after streaming)
  const extractText = (node: ReactNode): string => {
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(extractText).join('');
    if (node && typeof node === 'object' && 'props' in node) {
      return extractText((node as any).props.children);
    }
    return '';
  };
  const safeChildren = extractText(children);
  // rehype-highlight sets classes like "hljs language-cpp" (hljs first) — grab
  // the real language token so the label/extension are correct (previously the
  // header showed "hljs" because split()[0] picked the highlighter's class).
  const rawLanguage =
    (className || '').match(/(?:^|\s)language-([A-Za-z0-9_-]+)/)?.[1]?.toLowerCase() || '';
  // Non-code fences (plaintext/text/hljs) are descriptions, not files.
  const language = ['plaintext', 'text', 'txt', 'text/plain', 'hljs'].includes(rawLanguage) ? '' : rawLanguage;
  const extension = language ? languageExtensions[language] || `.${language}` : '.txt';
  // Sensible default filename when the model didn't emit a "# path" first line.
  const suggestedPath = language ? `main${extension}` : '';

  // Detect file path, delete directive, or EDIT block in first line
  const { detectedPath, codeContent, isDelete, editInfo } = useMemo(() => {
    const lines = safeChildren.split('\n');
    const firstLine = lines[0]?.trim() || '';

    // EDIT block (surgical change): "// EDIT: path" + OLD:/---/NEW:
    const edit = parseEditBlock(safeChildren);
    if (edit && onApplyEdit) {
      return { detectedPath: edit.path, codeContent: edit.newString, isDelete: false, editInfo: edit };
    }
    
    // Check for DELETE directive first
    const deleteMatch = firstLine.match(DELETE_PATH_RE);
    if (deleteMatch) {
      return {
        detectedPath: deleteMatch[1],
        codeContent: lines.slice(1).join('\n').trimStart(),
        isDelete: true,
        editInfo: null,
      };
    }
    
    // Normal file path detection
    const match = firstLine.match(FILE_PATH_RE);
    if (match) {
      return {
        detectedPath: match[1],
        codeContent: lines.slice(1).join('\n').trimStart(),
        isDelete: false,
        editInfo: null,
      };
    }
    return { detectedPath: null, codeContent: safeChildren, isDelete: false, editInfo: null };
  }, [safeChildren, onApplyEdit]);

  const displayContent = detectedPath && !isDelete && !editInfo ? codeContent : safeChildren;

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
          {editInfo ? <FileCode size={12} className="text-amber-400" /> : <FileCode size={12} />}
          <span>{detectedPath || suggestedPath || language || 'code'}</span>
          {editInfo && (
            <span className="text-[9px] font-medium bg-amber-900/40 text-amber-400 px-1.5 py-0.5 rounded-full">EDIT</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* EDIT Apply button — surgical change to an existing file */}
          {editInfo && onApplyEdit && (
            <button
              onClick={() => onApplyEdit(editInfo.path, editInfo.oldString, editInfo.newString)}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-all duration-150 hover:bg-amber-900/40 hover:text-amber-300 text-amber-400 active:scale-95"
              title={`Apply edit to ${editInfo.path}`}
            >
              <FilePlus2 size={12} />
              Apply Edit
            </button>
          )}
          {/* Delete button when isDelete is detected */}
          {isDelete && detectedPath && onDeleteFile && (
            <button
              onClick={() => onDeleteFile(detectedPath!)}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-all duration-150 hover:bg-red-900/40 hover:text-red-300 text-red-400 active:scale-95"
              title={`Delete ${detectedPath}`}
            >
              <Trash2 size={12} />
              Delete
            </button>
          )}
          {/* Always show Apply/Save button when onApplyCode is available (unless it's a delete or edit) */}
          {!isDelete && !editInfo && onApplyCode && (
            detectedPath ? (
              <button
                onClick={() => onApplyCode(detectedPath!, displayContent)}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-all duration-150 hover:bg-purple-900/40 hover:text-purple-300 text-purple-400 active:scale-95"
                title={`Apply to ${detectedPath}`}
              >
                <FilePlus2 size={12} />
                Apply
              </button>
            ) : (
              <>
                {/* No "# path" line, but the language is known — one-click Apply
                    with a sensible default filename (main.<ext>). */}
                {suggestedPath && (
                  <button
                    onClick={() => onApplyCode(suggestedPath, displayContent)}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-all duration-150 hover:bg-purple-900/40 hover:text-purple-300 text-purple-400 active:scale-95"
                    title={`Apply as ${suggestedPath} (in the workspace root)`}
                  >
                    <FilePlus2 size={12} />
                    Apply
                  </button>
                )}
                {showPathInput ? (
                  <div className="flex items-center gap-1">
                    <input
                      ref={pathInputRef}
                      type="text"
                      value={manualPath}
                      onChange={(e) => setManualPath(e.target.value)}
                      placeholder={suggestedPath || 'path/to/file.ext'}
                      className="w-28 px-1.5 py-0.5 text-[10px] bg-gray-800 border border-gray-600 rounded text-white placeholder-gray-500 outline-none focus:border-blue-500"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const path = manualPath.trim() || suggestedPath;
                          if (path) {
                            onApplyCode(path, safeChildren);
                            setShowPathInput(false);
                            setManualPath('');
                          }
                        }
                        if (e.key === 'Escape') {
                          setShowPathInput(false);
                          setManualPath('');
                        }
                      }}
                      onBlur={() => {
                        if (!manualPath.trim()) {
                          setShowPathInput(false);
                        }
                      }}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                    />
                    <button
                      onClick={() => {
                        const path = manualPath.trim() || suggestedPath;
                        if (path) {
                          onApplyCode(path, safeChildren);
                          setShowPathInput(false);
                          setManualPath('');
                        }
                      }}
                      className="p-0.5 hover:bg-gray-700 rounded text-gray-400 hover:text-blue-400 transition-colors"
                      disabled={!manualPath.trim() && !suggestedPath}
                    >
                      <Check size={10} />
                    </button>
                    <button
                      onClick={() => { setShowPathInput(false); setManualPath(''); }}
                      className="p-0.5 hover:bg-gray-700 rounded text-gray-400 hover:text-red-400 transition-colors"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setManualPath(suggestedPath);
                      setShowPathInput(true);
                      setTimeout(() => {
                        pathInputRef.current?.focus();
                        pathInputRef.current?.select();
                      }, 50);
                    }}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-all duration-150 hover:bg-purple-900/40 hover:text-purple-300 text-purple-400 active:scale-95"
                    title="Specify file path to save this code"
                  >
                    <FilePlus2 size={12} />
                    {suggestedPath ? 'Path...' : 'Save as...'}
                  </button>
                )}
              </>
            )
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
      {editInfo ? (
        <div className="text-[11px] font-mono !mt-0 !rounded-t-none border-t border-gray-800">
          <div className="px-3 py-1.5 bg-red-950/30 border-b border-gray-800/60">
            <span className="text-[9px] text-red-400 font-sans font-medium uppercase tracking-wider">Old — {editInfo.oldString.split('\n').length} line{editInfo.oldString.split('\n').length !== 1 ? 's' : ''}</span>
            <pre className="whitespace-pre-wrap text-red-300/80 mt-1">{editInfo.oldString}</pre>
          </div>
          <div className="px-3 py-1.5 bg-green-950/30">
            <span className="text-[9px] text-green-400 font-sans font-medium uppercase tracking-wider">New — {editInfo.newString.split('\n').length} line{editInfo.newString.split('\n').length !== 1 ? 's' : ''}</span>
            <pre className="whitespace-pre-wrap text-green-300/90 mt-1">{editInfo.newString}</pre>
          </div>
        </div>
      ) : (
        <pre className="!mt-0 !rounded-t-none">
          <code className={className}>{displayContent}</code>
        </pre>
      )}
    </div>
  );
});

interface Props {
  message: MessageType;
  isStreaming?: boolean;
  stage?: string;
  liveDuration?: number;
  index?: number;
  onEdit?: (index: number, newContent: string) => void;
  onDelete?: (index: number) => void;
  onRegenerate?: () => void;
  isLastAssistant?: boolean;
  onApplyCode?: (filePath: string, codeContent: string) => void;
  onApplyEdit?: (filePath: string, oldString: string, newString: string) => void;
  onDeleteFile?: (filePath: string) => void;
  onApplyAll?: (files: { filePath: string; content: string; oldString?: string; newString?: string }[]) => void;
  selected?: boolean;
  onToggleSelect?: (index: number) => void;
  selectable?: boolean;
  onFork?: (index: number) => void;
}

const stageLabels: Record<string, string> = {
  // Agent loop (auto-apply mode)
  'agent:thinking': '🤖 Planning approach',
  'agent:reading': '📂 Reading workspace files',
  'agent:tool': '🔧 Using tools',
  'agent:verify': '✅ Verifying changes',
  'agent:working': '🤖 Working through it',
  'agent:done': '✨ Finishing up',
  // Regular pipeline stages (approval / chat / image modes)
  'reading:workspace': '📂 Reading workspace',
  'search:web': '🌐 Searching the web',
  'search:docs': '📚 Searching docs',
  'tool:executing': '🔧 Running a tool',
  'chat:thinking': '💬 Thinking',
  'vision:analyzing': '🔍 Analyzing image',
  'planning:create': '📋 Creating a plan',
  'planning:evaluating': '📋 Evaluating the plan',
  'image:generating': '🎨 Generating image',
  'code:generating': '💻 Writing code',
  'writing:files': '✏️ Writing files',
  'summary:writing': '✨ Polishing response',
  // Fallbacks for legacy / unknown namespaced stages
  'agent': '🤖 Working',
  'reading': '📂 Reading workspace',
  'writing': '✏️ Writing files',
  'code': '💻 Writing code',
  'editing': '✏️ Editing files',
  'summary': '✨ Polishing response',
  'chat': '💬 Thinking',
  'search': '🌐 Searching the web',
  'planning': '📋 Creating a plan',
  'vision': '🔍 Analyzing image',
};

// Longest-prefix match so namespaced stages (e.g. 'search:docs') resolve to
// their specific label instead of the short generic one ('search').
function getStageLabel(stage?: string): string | null {
  if (!stage) return null;
  let best: string | null = null;
  for (const key of Object.keys(stageLabels)) {
    if (stage.startsWith(key) && (best === null || key.length > best.length)) {
      best = key;
    }
  }
  return best ? stageLabels[best] : '⚙️ Processing';
}

export const Message = memo(function Message({ message, isStreaming, stage, liveDuration, index, onEdit, onDelete, onRegenerate, isLastAssistant, onApplyCode, onApplyEdit, onDeleteFile, onApplyAll, selected, onToggleSelect, selectable, onFork }: Props) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const isUser = message.role === 'user';
  const stageLabel = getStageLabel(stage);
  const { toast } = useToast();

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

  // Strip the [image:...] tag from display and convert [generated_image:...] to markdown images
  const displayContent = message.content
    .replace(/\[image:[^\]]+\]/g, '')
    .replace(/\[generated_image:([^\]]+)\]/g, '![Generated image](/api/generated/$1)')
    .trim();

  // Extract applicable files for "Apply All" button
  const applicableFiles = useMemo(
    () => (onApplyAll && !isUser && displayContent && !isStreaming ? extractApplicableFiles(displayContent) : []),
    [onApplyAll, isUser, displayContent, isStreaming]
  );

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
        return <CodeBlock className={codeChild.props?.className} onApplyCode={onApplyCode} onApplyEdit={onApplyEdit} onDeleteFile={onDeleteFile}>{codeChild.props?.children}</CodeBlock>;
      }
      return <pre>{children}</pre>;
    },
    img: ({ src, alt }: { src?: string; alt?: string }) => {
      if (!src) return null;
      const isGenerated = src.startsWith('/api/generated/');
      const filename = isGenerated ? src.split('/').pop() || '' : '';

      const handleDownload = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (filename) {
          const a = document.createElement('a');
          a.href = `/api/generated/${filename}/download`;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
      };

      return (
        <div className="relative group my-3">
          <button
            onClick={() => setLightboxImage(src)}
            className="block w-full"
            title={alt || 'View full size'}
          >
            <div className="relative overflow-hidden rounded-xl border border-gray-700/50 bg-gray-900/50">
              <img
                src={src}
                alt={alt || 'Generated image'}
                className="w-full max-h-[300px] object-contain cursor-pointer transition-all duration-200 group-hover:scale-[1.02] group-hover:brightness-110"
                loading="lazy"
              />
              {/* Hover overlay */}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-all duration-200 flex items-center justify-center">
                <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-black/50 backdrop-blur-sm px-3 py-1.5 rounded-lg flex items-center gap-2 text-white text-sm">
                  <ZoomIn size={16} />
                  <span>View full size</span>
                </div>
              </div>
              {/* Badge for generated images */}
              {isGenerated && (
                <div className="absolute top-2 left-2 px-2 py-0.5 bg-purple-600/80 backdrop-blur-sm rounded-full text-[10px] font-medium text-white flex items-center gap-1">
                  <ImageIcon size={10} />
                  Generated
                </div>
              )}
              {/* Download button on thumbnail */}
              {isGenerated && filename && (
                <button
                  onClick={handleDownload}
                  className="absolute top-2 right-2 p-1.5 bg-gray-900/70 hover:bg-gray-800 backdrop-blur-sm rounded-lg opacity-0 group-hover:opacity-100 transition-all duration-200 text-white hover:text-emerald-400 active:scale-90"
                  title="Download image"
                >
                  <Download size={14} />
                </button>
              )}
            </div>
          </button>
        </div>
      );
    },
  }), [onApplyCode, onApplyEdit]);

  return (
    <div className={`group relative flex gap-3 px-4 py-6 animate-fade-in transition-colors duration-200 ${isUser ? '' : 'bg-gray-900/40'} ${selected ? 'bg-blue-900/20' : ''}`}>
      <div className="flex items-start gap-3">
        {/* Selection checkbox - always visible on mobile, on hover on desktop */}
        {selectable && !isStreaming && (
          <div className="flex-shrink-0 pt-2 opacity-60 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-150">
            <button
              onClick={() => onToggleSelect?.(index!)}
              className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${
                selected
                  ? 'bg-blue-500 border-blue-500'
                  : 'border-gray-600 hover:border-gray-400 bg-gray-800'
              }`}
            >
              {selected && <Check size={12} className="text-white" />}
            </button>
          </div>
        )}

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
          {!editing && index !== undefined && !isStreaming && (
            <span className="flex items-center gap-0.5 ml-1">
              {isUser && onEdit && (
                <button
                  onClick={startEdit}
                  className="p-1 hover:bg-gray-700 rounded text-gray-500 hover:text-gray-300 transition-all"
                  title="Edit message"
                >
                  <Pencil size={12} />
                </button>
              )}
              {onDelete && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(index!);
                    toast('success', 'Message deleted');
                  }}
                  className="p-1 hover:bg-gray-700 rounded text-gray-500 hover:text-red-400 transition-all"
                  title="Delete message"
                >
                  <Trash2 size={12} />
                </button>
              )}
              {/* Fork button */}
              {onFork && !isStreaming && (
                <button
                  onClick={() => onFork(index!)}
                  className="p-1 hover:bg-gray-700 rounded text-gray-500 hover:text-amber-400 transition-all"
                  title="Fork conversation from here"
                >
                  <GitBranch size={12} />
                </button>
              )}
              {/* Apply All button */}
              {applicableFiles.length >= 2 && (
                <button
                  onClick={() => onApplyAll?.(applicableFiles)}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-emerald-700/30 text-emerald-400 hover:bg-emerald-700/50 transition-all active:scale-95"
                  title={`Apply all ${applicableFiles.length} files`}
                >
                  <Layers size={11} />
                  Apply All ({applicableFiles.length})
                </button>
              )}
              {/* Markdown/Raw toggle */}
              {!isUser && displayContent && !isStreaming && (
                <button
                  onClick={() => setShowRaw(!showRaw)}
                  className={`p-1 rounded transition-all ${showRaw ? 'bg-gray-700 text-amber-400' : 'text-gray-500 hover:text-gray-300'}`}
                  title={showRaw ? 'Show rendered' : 'Show raw markdown'}
                >
                  {showRaw ? <FileText size={12} /> : <Code2 size={12} />}
                </button>
              )}
            </span>
          )}
        </div>

        {isStreaming && stageLabel && (
          <div className="mb-2 inline-flex items-center gap-2 text-xs text-gray-400">
            <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
            <span>{stageLabel}</span>
            {liveDuration !== undefined && (
              <span className="tabular-nums text-gray-500">
                ⏱️ {liveDuration < 1000 ? `${liveDuration}ms` : `${(liveDuration / 1000).toFixed(1)}s`}
              </span>
            )}
          </div>
        )}

        {/* Collapsible Thinking section — shown above the answer for reasoning models */}
        {!isUser && message.thinking && (
          <div className="mb-3 rounded-xl border border-gray-800/80 bg-gray-950/40 overflow-hidden">
            <button
              onClick={() => setThinkingOpen(!thinkingOpen)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-gray-900/60"
              title={thinkingOpen ? 'Collapse thinking' : 'Expand thinking'}
            >
              <Brain size={12} className="text-purple-400 flex-shrink-0" />
              <span className="text-[11px] font-medium text-gray-400 uppercase tracking-wider flex-1">
                Thinking
              </span>
              {isStreaming && (
                <span className="flex items-center gap-1 text-[10px] text-purple-400">
                  <span className="w-1 h-1 bg-purple-400 rounded-full animate-pulse" />
                  thinking
                </span>
              )}
              <ChevronDown
                size={12}
                className={`text-gray-500 transition-transform duration-200 flex-shrink-0 ${thinkingOpen ? 'rotate-180' : ''}`}
              />
            </button>
            {thinkingOpen && (
              <div className="max-h-48 overflow-y-auto px-3 pb-3 text-xs text-gray-500 leading-relaxed whitespace-pre-wrap border-t border-gray-800/60 pt-2 font-mono">
                {message.thinking}
              </div>
            )}
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
              showRaw ? (
                <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap overflow-x-auto bg-gray-950/50 rounded-lg p-3 border border-gray-800">{displayContent}</pre>
              ) : (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={rehypePlugins}
                  components={markdownComponents}
                >
                  {displayContent}
                </ReactMarkdown>
              )
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
            {!isUser && message.durationMs && !isStreaming && (
              <span className="text-xs text-gray-500 mr-1" title="Response time">
                ⏱️ {message.durationMs < 1000 ? `${message.durationMs}ms` : `${(message.durationMs / 1000).toFixed(1)}s`}
              </span>
            )}
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

      {/* Image lightbox modal */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center animate-fade-in"
          onClick={() => setLightboxImage(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') setLightboxImage(null); }}
          tabIndex={-1}
          ref={(el) => { if (el) el.focus(); }}
        >
          <button
            className="absolute top-4 right-4 p-2 bg-gray-800/80 hover:bg-gray-700 rounded-full text-white transition-colors z-10"
            onClick={() => setLightboxImage(null)}
            title="Close"
          >
            <X size={24} />
          </button>
          <button
            className="absolute bottom-6 left-1/2 -translate-x-1/2 px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 rounded-xl text-white text-sm font-medium transition-all duration-200 flex items-center gap-2 shadow-lg shadow-emerald-900/30 active:scale-95"
            onClick={() => {
              const filename = lightboxImage.split('/').pop() || 'generated-image';
              const a = document.createElement('a');
              a.href = `/api/generated/${filename}/download`;
              a.download = filename;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            }}
            title="Download image"
          >
            <Download size={16} />
            <span>Save to folder</span>
          </button>
          <img
            src={lightboxImage}
            alt="Full size"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
});
