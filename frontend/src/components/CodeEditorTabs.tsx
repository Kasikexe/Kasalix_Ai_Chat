import { useState, useRef, useMemo, useCallback } from 'react';
import { X, AlertTriangle, Save, Check, Undo2, Redo2, FileCode } from 'lucide-react';
import { api } from '../services/api';
import { getHighlightedHtml } from '../utils/format';

interface OpenFile {
  path: string;
  name: string;
  language: string | null;
  content: string;
  originalContent: string;
  saved: boolean;
  dirty: boolean;
}

interface Props {
  files: OpenFile[];
  activeFile: string | null;
  onFileSelect: (path: string) => void;
  onFileClose: (path: string) => void;
  onFileContentChange: (path: string, content: string) => void;
  onFileSave: (path: string, content: string) => void;
}

function EditorWithLineNumbers({
  value, onChange, language, onSave,
}: {
  value: string;
  onChange: (val: string) => void;
  language: string | null;
  onSave?: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const historyRef = useRef<{ stack: string[]; index: number }>({
    stack: [value],
    index: 0,
  });
  const skipHistoryRef = useRef(false);

  const lines = useMemo(() => value.split('\n'), [value]);
  const lineCount = lines.length;

  const prevValueRef = useRef(value);
  if (value !== prevValueRef.current) {
    prevValueRef.current = value;
    if (!skipHistoryRef.current) {
      const hist = historyRef.current;
      hist.stack = hist.stack.slice(0, hist.index + 1);
      hist.stack.push(value);
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

    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      onSave?.();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
      e.preventDefault();
      redo();
      return;
    }
  };

  return (
    <div className="flex flex-1 min-h-0">
      <div
        ref={gutterRef}
        className="select-none text-right pr-3 py-3 text-xs leading-relaxed font-mono text-gray-600 bg-gray-950/50 overflow-hidden border-r border-gray-800/50"
        style={{ minWidth: `${Math.max(3, String(lineCount).length)}ch`, width: `${Math.max(3, String(lineCount).length) + 1}ch` }}
      >
        {lines.map((_, i) => (
          <div key={i} className="leading-relaxed">{i + 1}</div>
        ))}
      </div>

      <div className="relative flex-1 min-h-0">
        <div
          ref={highlightRef}
          className="absolute inset-0 overflow-auto pointer-events-none"
          aria-hidden="true"
        >
          <pre className="py-3 px-4 text-xs leading-relaxed font-mono">
            <code
              dangerouslySetInnerHTML={{
                __html: getHighlightedHtml(value, language) + '\n',
              }}
            />
          </pre>
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={handleKeyDown}
          className="absolute inset-0 w-full h-full bg-transparent text-transparent caret-gray-200 text-xs font-mono resize-none outline-none border-0 py-3 px-4 leading-relaxed overflow-auto"
          spellCheck={false}
          autoFocus
        />
      </div>

      <div className="flex flex-col gap-1 px-1.5 py-2 bg-gray-950/50 border-l border-gray-800/50">
        <button onClick={undo} disabled={!canUndo}
          className="p-1 rounded hover:bg-gray-800 disabled:opacity-30 disabled:cursor-default text-gray-400 hover:text-gray-200 transition-colors"
          title="Undo (Ctrl+Z)">
          <Undo2 size={14} />
        </button>
        <button onClick={redo} disabled={!canRedo}
          className="p-1 rounded hover:bg-gray-800 disabled:opacity-30 disabled:cursor-default text-gray-400 hover:text-gray-200 transition-colors"
          title="Redo (Ctrl+Shift+Z)">
          <Redo2 size={14} />
        </button>
      </div>
    </div>
  );
}

export function CodeEditorTabs({ files, activeFile, onFileSelect, onFileClose, onFileContentChange, onFileSave }: Props) {
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const activeOpenFile = files.find((f) => f.path === activeFile);

  const handleSave = useCallback(async (file: OpenFile) => {
    setSaving((prev) => ({ ...prev, [file.path]: true }));
    try {
      await api.writeFile(file.path, file.content);
      onFileSave(file.path, file.content);
    } catch (e) {
      console.error('Save failed:', e);
    }
    setSaving((prev) => ({ ...prev, [file.path]: false }));
  }, [onFileSave]);

  if (files.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-950/30">
        <div className="text-center max-w-sm animate-fade-in">
          <FileCode size={48} className="mx-auto text-gray-700 mb-4" />
          <p className="text-sm text-gray-500">Select a file from the file tree to start editing</p>
          <p className="text-xs text-gray-600 mt-2">Or ask the AI to create one</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Tabs bar */}
      <div className="flex items-center bg-gray-900/80 border-b border-gray-800 overflow-x-auto scrollbar-none flex-shrink-0">
        {files.map((file) => {
          const isActive = file.path === activeFile;
          return (
            <div
              key={file.path}
              onClick={() => onFileSelect(file.path)}
              className={`group flex items-center gap-1.5 px-3 py-2 text-xs cursor-pointer border-r border-gray-800 transition-colors select-none ${
                isActive
                  ? 'bg-gray-950 text-gray-200 border-t-2 border-t-purple-500'
                  : 'bg-gray-900/50 text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
              }`}
            >
              <FileCode size={12} className="text-blue-400 flex-shrink-0" />
              <span className="truncate max-w-[120px]">{file.name}</span>
              {file.dirty && (
                <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" title="Unsaved changes" />
              )}
              {file.saved && !file.dirty && (
                <Check size={10} className="text-emerald-500 flex-shrink-0" />
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onFileClose(file.path); }}
                className="p-0.5 rounded hover:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity text-gray-500 hover:text-gray-200 flex-shrink-0"
              >
                <X size={10} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Editor area */}
      <div className="flex-1 min-h-0 flex flex-col">
        {activeOpenFile && (
          <div className="flex-1 min-h-0 flex flex-col">
            {/* Editor */}
            <div className="flex-1 min-h-0 flex">
              <EditorWithLineNumbers
                value={activeOpenFile.content}
                onChange={(val) => onFileContentChange(activeOpenFile.path, val)}
                language={activeOpenFile.language}
                onSave={() => handleSave(activeOpenFile)}
              />
            </div>

            {/* Save bar */}
            {activeOpenFile.dirty && (
              <div className="flex items-center gap-2 px-4 py-1.5 bg-amber-950/30 border-t border-amber-800/30 flex-shrink-0">
                <AlertTriangle size={12} className="text-amber-400" />
                <span className="text-xs text-amber-300/80 flex-1">Unsaved changes</span>
                <button
                  onClick={() => handleSave(activeOpenFile)}
                  disabled={saving[activeOpenFile.path]}
                  className="flex items-center gap-1.5 px-3 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {saving[activeOpenFile.path] ? (
                    <><span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" /> Saving...</>
                  ) : (
                    <><Save size={12} /> Save (Ctrl+S)</>
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
