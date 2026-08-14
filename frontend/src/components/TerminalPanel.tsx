import { useState, useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { Terminal, Trash2, Loader, X, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../services/api';

export interface TerminalEntry {
  type: 'command' | 'stdout' | 'stderr' | 'system' | 'error';
  text: string;
  timestamp: number;
}

export interface TerminalPanelHandle {
  /** Append an entry to the terminal (used to show the agent's run_command output). */
  push: (entry: TerminalEntry) => void;
}

interface Props {
  cwd: string;
  height?: number;
  onHeightChange?: (height: number) => void;
  onClose?: () => void;
}

export const TerminalPanel = forwardRef<TerminalPanelHandle, Props>(function TerminalPanel({ cwd, height = 200, onHeightChange, onClose }, ref) {
  const [entries, setEntries] = useState<TerminalEntry[]>([
    { type: 'system', text: `Terminal ready — ${cwd}`, timestamp: Date.now() },
  ]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [expanded, setExpanded] = useState(true);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom on new output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [entries]);

  // Focus input when panel is clicked
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const addEntry = useCallback((entry: TerminalEntry) => {
    setEntries((prev) => [...prev, entry]);
  }, []);

  // Imperative handle so the parent can feed the agent's run_command output in.
  useImperativeHandle(ref, () => ({
    push: (entry: TerminalEntry) => addEntry(entry),
  }), [addEntry]);

  const execute = useCallback(async (cmd: string) => {
    if (!cmd.trim() || running) return;

    const trimmed = cmd.trim();
    setEntries((prev) => [...prev, { type: 'command', text: `$ ${trimmed}`, timestamp: Date.now() }]);
    setRunning(true);
    setHistory((prev) => [...prev, trimmed]);
    setHistoryIdx(-1);

    // Handle special commands
    if (trimmed === 'clear') {
      setEntries([]);
      setRunning(false);
      setInput('');
      return;
    }

    if (trimmed === 'cls') {
      setEntries([]);
      setRunning(false);
      setInput('');
      return;
    }

    try {
      const result = await api.executeTerminal(trimmed, cwd);
      if (result.stdout) {
        // Split into lines for better display
        const lines = result.stdout.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            addEntry({ type: 'stdout', text: line, timestamp: Date.now() });
          }
        }
      }
      if (result.stderr) {
        const lines = result.stderr.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            addEntry({ type: 'stderr', text: line, timestamp: Date.now() });
          }
        }
      }
      if (result.killed) {
        addEntry({ type: 'error', text: '⚠️ Command timed out (60s limit)', timestamp: Date.now() });
      } else if (result.code !== 0 && !result.stdout && !result.stderr) {
        addEntry({ type: 'error', text: `⚠️ Process exited with code ${result.code}`, timestamp: Date.now() });
      }
    } catch (e) {
      addEntry({ type: 'error', text: `Error: ${e instanceof Error ? e.message : 'Command failed'}`, timestamp: Date.now() });
    }

    setRunning(false);
    setInput('');
  }, [cwd, running, addEntry]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      execute(input);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const newIdx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(newIdx);
      setInput(history[newIdx]);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx === -1) return;
      const newIdx = historyIdx + 1;
      if (newIdx >= history.length) {
        setHistoryIdx(-1);
        setInput('');
      } else {
        setHistoryIdx(newIdx);
        setInput(history[newIdx]);
      }
      return;
    }

    // Ctrl+C: cancel running command (not implemented yet in backend)
    if (e.key === 'c' && (e.ctrlKey || e.metaKey) && running) {
      // We'll add abort support later
      return;
    }
  };

  // Resize handle at top
  const [resizing, setResizing] = useState(false);
  const startResizeY = useRef(0);
  const startHeight = useRef(height);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true);
    startResizeY.current = e.clientY;
    startHeight.current = height;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleMouseMove = (e: MouseEvent) => {
    const delta = startResizeY.current - e.clientY;
    const newHeight = Math.max(100, Math.min(600, startHeight.current + delta));
    onHeightChange?.(newHeight);
  };

  const handleMouseUp = () => {
    setResizing(false);
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };

  if (!expanded) {
    return (
      <div className="border-t border-gray-800 bg-gray-900">
        <button
          onClick={() => setExpanded(true)}
          className="w-full flex items-center justify-between px-4 py-1.5 hover:bg-gray-800 transition-colors"
        >
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Terminal size={12} />
            <span>Terminal</span>
          </div>
          <ChevronUp size={14} className="text-gray-500" />
        </button>
      </div>
    );
  }

  return (
    <div
      className="border-t border-gray-800 bg-gray-950 flex flex-col"
      style={{ height }}
    >
      {/* Resize handle */}
      <div
        className={`h-1 cursor-ns-resize hover:bg-purple-500/30 transition-colors flex-shrink-0 ${resizing ? 'bg-purple-500/50' : ''}`}
        onMouseDown={handleMouseDown}
      />

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-gray-800 bg-gray-900 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Terminal size={12} className="text-gray-400" />
          <span className="text-xs text-gray-400 font-medium">Terminal</span>
          <span className="text-[10px] text-gray-600 font-mono truncate max-w-[200px]">{cwd}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setEntries([])}
            className="p-1 hover:bg-gray-800 rounded text-gray-500 hover:text-gray-300 transition-colors"
            title="Clear"
          >
            <Trash2 size={12} />
          </button>
          <button
            onClick={() => setExpanded(false)}
            className="p-1 hover:bg-gray-800 rounded text-gray-500 hover:text-gray-300 transition-colors"
            title="Collapse"
          >
            <ChevronDown size={12} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-800 rounded text-gray-500 hover:text-gray-300 transition-colors"
              title="Close"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Output area */}
      <div
        ref={outputRef}
        className="flex-1 overflow-y-auto p-2 font-mono text-xs leading-relaxed space-y-0.5 bg-gray-950"
      >
        {entries.map((entry, i) => {
          switch (entry.type) {
            case 'command':
              return (
                <div key={i} className="flex gap-2">
                  <span className="text-emerald-400 flex-shrink-0 select-none">❯</span>
                  <span className="text-gray-200">{entry.text.slice(2)}</span>
                </div>
              );
            case 'stdout':
              return (
                <div key={i} className="text-gray-400 pl-4">
                  {entry.text}
                </div>
              );
            case 'stderr':
              return (
                <div key={i} className="text-red-400 pl-4">
                  {entry.text}
                </div>
              );
            case 'error':
              return (
                <div key={i} className="text-red-400 pl-4 flex items-center gap-1">
                  {entry.text}
                </div>
              );
            case 'system':
              return (
                <div key={i} className="text-gray-600 italic">
                  {/* {entry.text} */}
                </div>
              );
            default:
              return null;
          }
        })}
        {running && (
          <div className="flex items-center gap-2 text-gray-500 pl-4">
            <Loader size={10} className="animate-spin" />
            <span>Running...</span>
          </div>
        )}
        {/* Input line - always visible */}
        <div className="flex items-center gap-2 pt-1">
          <span className="text-emerald-400 flex-shrink-0 select-none">❯</span>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={running}
            placeholder={running ? 'Waiting for command...' : 'Type a command...'}
            className="flex-1 bg-transparent text-gray-200 outline-none placeholder-gray-600"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>
    </div>
  );
});
