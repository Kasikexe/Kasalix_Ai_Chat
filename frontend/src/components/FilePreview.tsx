import { useState, useEffect, useRef, useMemo } from 'react';
import 'highlight.js/styles/github-dark.css';
import { X, FileCode, AlertTriangle, File, Edit3, Save, Check, Undo2, Redo2 } from 'lucide-react';
import { api } from '../services/api';
import { DiffView } from './DiffView';
import { getHighlightedHtml } from '../utils/format';

interface FileContent {
  content: string | null;
  language: string | null;
  size: number;
  truncated: boolean;
  binary: boolean;
}

interface Props {
  filePath: string;
  fileName: string;
  onClose: () => void;
}

function EditorWithLineNumbers({ value, onChange, language }: {
  value: string;
  onChange: (val: string) => void;
  language: string | null;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  // Undo/redo history
  const historyRef = useRef<{ stack: string[]; index: number }>({
    stack: [value],
    index: 0,
  });
  const skipHistoryRef = useRef(false);

  const lines = useMemo(() => value.split('\n'), [value]);
  const lineCount = lines.length;

  // Push to history when value changes (from typing, not from undo/redo)
  const prevValueRef = useRef(value);
  if (value !== prevValueRef.current) {
    prevValueRef.current = value;
    if (!skipHistoryRef.current) {
      const hist = historyRef.current;
      // Discard any future states beyond current index
      hist.stack = hist.stack.slice(0, hist.index + 1);
      hist.stack.push(value);
      // Cap at 100 entries
      if (hist.stack.length > 100) hist.stack.shift();
      hist.index = hist.stack.length - 1;
    }
    skipHistoryRef.current = false;
  }

  const syncScroll = () => {
    if (textareaRef.current && highlightRef.current && gutterRef.current) {
      const { scrollTop } = textareaRef.current;
      highlightRef.current.scrollTop = scrollTop;
      gutterRef.current.scrollTop = scrollTop;
    }
  };

  const undo = () => {
    const hist = historyRef.current;
    if (hist.index <= 0) return;
    hist.index--;
    skipHistoryRef.current = true;
    onChange(hist.stack[hist.index]);
  };

  const redo = () => {
    const hist = historyRef.current;
    if (hist.index >= hist.stack.length - 1) return;
    hist.index++;
    skipHistoryRef.current = true;
    onChange(hist.stack[hist.index]);
  };

  const hist = historyRef.current;
  const canUndo = hist.index > 0;
  const canRedo = hist.index < hist.stack.length - 1;

  // Handle tab and undo/redo keys
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newVal = value.substring(0, start) + '  ' + value.substring(end);
      onChange(newVal);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        redo();
      } else {
        undo();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
      e.preventDefault();
      redo();
      return;
    }
  };

  return (
    <div className="flex border-t border-b border-gray-800">
      {/* Line numbers gutter */}
      <div
        ref={gutterRef}
        className="select-none text-right pr-3 py-4 text-xs leading-relaxed font-mono text-gray-600 bg-gray-950 overflow-hidden"
        style={{ minWidth: `${Math.max(3, String(lineCount).length)}ch`, width: `${Math.max(3, String(lineCount).length) + 1}ch` }}
      >
        {lines.map((_, i) => (
          <div key={i} className="leading-relaxed">{i + 1}</div>
        ))}
      </div>

      {/* Editor container with overlay technique */}
      <div className="relative flex-1 min-h-[200px] max-h-[40vh]">
        {/* Syntax-highlighted background */}
        <div
          ref={highlightRef}
          className="absolute inset-0 overflow-auto pointer-events-none"
          aria-hidden="true"
        >
          <pre className="py-4 px-4 text-xs leading-relaxed font-mono">
            <code
              dangerouslySetInnerHTML={{
                __html: getHighlightedHtml(value, language) + '\n',
              }}
            />
          </pre>
        </div>

        {/* Transparent text textarea overlay */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={handleKeyDown}
          className="absolute inset-0 w-full h-full bg-transparent text-transparent caret-gray-200 text-xs font-mono resize-none outline-none border-0 py-4 px-4 leading-relaxed overflow-auto"
          spellCheck={false}
          autoFocus
        />
      </div>

      {/* Undo/redo buttons */}
      <div className="flex flex-col gap-1 px-1.5 py-2 bg-gray-950 border-l border-gray-800">
        <button
          onClick={undo}
          disabled={!canUndo}
          className="p-1 rounded hover:bg-gray-800 disabled:opacity-30 disabled:cursor-default text-gray-400 hover:text-gray-200 transition-colors"
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={14} />
        </button>
        <button
          onClick={redo}
          disabled={!canRedo}
          className="p-1 rounded hover:bg-gray-800 disabled:opacity-30 disabled:cursor-default text-gray-400 hover:text-gray-200 transition-colors"
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo2 size={14} />
        </button>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function FilePreview({ filePath, fileName, onClose }: Props) {
  const [data, setData] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [showingDiff, setShowingDiff] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEditing(false);
    setShowingDiff(false);
    setSaved(false);

    api.getFileContent(filePath).then((result) => {
      if (!cancelled) {
        const fc = result as FileContent;
        setData(fc);
        setEditContent(fc.content || '');
        setLoading(false);
      }
    }).catch((e) => {
      if (!cancelled) {
        setError(e instanceof Error ? e.message : 'Failed to load file');
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [filePath]);

  const startEditing = () => {
    setEditContent(data?.content || '');
    setEditing(true);
    setShowingDiff(false);
  };

  const cancelEditing = () => {
    setEditing(false);
    setShowingDiff(false);
    setEditContent(data?.content || '');
  };

  const reviewDiff = () => {
    setShowingDiff(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.writeFile(filePath, editContent);
      setSaved(true);
      setEditing(false);
      setShowingDiff(false);
      // Reload content
      const result = await api.getFileContent(filePath);
      const fc = result as FileContent;
      setData(fc);
      setEditContent(fc.content || '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save file');
    }
    setSaving(false);
  };

  return (
    <div className="border-t border-gray-800">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-900/80 border-b border-gray-800">
        <FileCode size={14} className="text-blue-400 flex-shrink-0" />
        <span className="text-sm text-gray-200 font-medium truncate">{fileName}</span>
        <span className="text-[10px] text-gray-600 flex-shrink-0">
          {data && formatSize(data.size)}
        </span>
        {data?.truncated && (
          <span className="text-[10px] text-amber-400 flex items-center gap-1 flex-shrink-0">
            <AlertTriangle size={10} />
            Truncated
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          {!editing && !saved && data?.content !== null && !data?.binary && (
            <button
              onClick={startEditing}
              className="p-1 hover:bg-gray-700 rounded text-gray-500 hover:text-gray-200 transition-colors"
              title="Edit file"
            >
              <Edit3 size={14} />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-700 rounded text-gray-500 hover:text-gray-200 transition-colors"
            title="Close preview"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-h-[40vh] overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="inline-flex items-center gap-2 text-xs text-gray-500">
              <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-pulse" />
              Loading...
            </div>
          </div>
        )}

        {error && !loading && (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
            <AlertTriangle size={20} className="text-red-400 mb-2" />
            <p className="text-xs text-red-400 mb-2">{error}</p>
          </div>
        )}

        {data?.binary && (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
            <File size={24} className="text-gray-500 mb-2" />
            <p className="text-xs text-gray-500">Binary file — preview not available</p>
          </div>
        )}

        {saved && (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
            <Check size={24} className="text-green-400 mb-2" />
            <p className="text-xs text-green-400">File saved successfully!</p>
          </div>
        )}

        {editing && !showingDiff && (
          <EditorWithLineNumbers
            value={editContent}
            onChange={setEditContent}
            language={data?.language || null}
          />
        )}

        {showingDiff && data?.content !== null && (
          <div className="p-3">
            <DiffView
              oldContent={data?.content || ''}
              newContent={editContent}
              filename={fileName}
            />
          </div>
        )}

        {!editing && !saved && data?.content !== null && !data?.binary && !loading && (
          <pre className="text-xs leading-relaxed overflow-x-auto">
            <code
              className={`language-${data?.language || 'plaintext'}`}
              dangerouslySetInnerHTML={{
                __html: getHighlightedHtml(data!.content!, data?.language || null),
              }}
            />
          </pre>
        )}
      </div>

      {/* Edit actions */}
      {editing && !showingDiff && (
        <div className="flex items-center gap-2 px-4 py-2 bg-gray-900/80 border-t border-gray-800">
          <button
            onClick={reviewDiff}
            disabled={editContent === data?.content}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs font-medium rounded-lg transition-colors"
          >
            Review changes
          </button>
          <button
            onClick={cancelEditing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium rounded-lg transition-colors border border-gray-700"
          >
            Cancel
          </button>
        </div>
      )}

      {showingDiff && (
        <div className="flex items-center gap-2 px-4 py-2 bg-gray-900/80 border-t border-gray-800">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? (
              <>
                <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                Saving...
              </>
            ) : (
              <>
                <Save size={14} />
                Approve & save
              </>
            )}
          </button>
          <button
            onClick={() => setShowingDiff(false)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium rounded-lg transition-colors border border-gray-700"
          >
            Back to edit
          </button>
        </div>
      )}
    </div>
  );
}
