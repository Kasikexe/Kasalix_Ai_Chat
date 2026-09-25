import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../services/api';

interface Line {
  kind: 'input' | 'output' | 'error' | 'info';
  text: string;
}

interface Props {
  workspacePath: string;
  /** Bumped by the agent when it runs a command — auto-scrolls to bottom */
  refreshToken?: number;
}

/** Workspace terminal: run commands directly against the backend's
 * sandboxed /api/terminal (workspace-confined, same protections as the agent). */
export function TerminalPanel({ workspacePath, refreshToken }: Props) {
  const [lines, setLines] = useState<Line[]>([
    { kind: 'info', text: `Terminal — workspace: ${workspacePath || '(none)'}` },
    { kind: 'info', text: 'Commands run in the workspace folder. 60s timeout, dangerous commands blocked.' },
  ]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  // Panel opens / agent ran a command → focus input (panel visible = user intent)
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = useCallback(async (cmd: string) => {
    const command = cmd.trim();
    if (!command || running) return;
    setRunning(true);
    setLines((prev) => [...prev, { kind: 'input', text: command }]);
    setHistory((prev) => [command, ...prev.filter((h) => h !== command)].slice(0, 50));
    setHistIdx(-1);
    setInput('');
    try {
      const r = await api.executeTerminal(command, workspacePath, workspacePath);
      const out: Line[] = [];
      if (r.stdout) out.push({ kind: 'output', text: r.stdout.replace(/\n$/, '') });
      if (r.stderr) out.push({ kind: 'error', text: r.stderr.replace(/\n$/, '') });
      if (!r.stdout && !r.stderr) out.push({ kind: 'info', text: r.success ? '(no output)' : `exit code ${r.code}` });
      else if (r.code !== undefined && r.code !== 0) out.push({ kind: 'error', text: `exit code ${r.code}` });
      setLines((prev) => [...prev, ...out]);
    } catch (e) {
      setLines((prev) => [...prev, { kind: 'error', text: e instanceof Error ? e.message : 'Command failed' }]);
    }
    setRunning(false);
    inputRef.current?.focus();
  }, [running, workspacePath]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { run(input); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(histIdx + 1, history.length - 1);
      if (next >= 0) { setHistIdx(next); setInput(history[next]); }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = histIdx - 1;
      setHistIdx(next);
      setInput(next >= 0 ? history[next] : '');
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#0b0f14]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap break-words">
            {l.kind === 'input' && (
              <span>
                <span className="text-emerald-400">$ </span>
                <span className="text-gray-100">{l.text}</span>
              </span>
            )}
            {l.kind === 'output' && <span className="text-gray-400">{l.text}</span>}
            {l.kind === 'error' && <span className="text-rose-400">{l.text}</span>}
            {l.kind === 'info' && <span className="text-gray-600 italic">{l.text}</span>}
          </div>
        ))}
        {running && (
          <div className="text-gray-600 animate-pulse">running…</div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-gray-800 px-3 py-1.5">
        <span className="text-emerald-400 text-[11px] font-mono flex-shrink-0">$</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={workspacePath ? 'python --version' : 'Select a workspace first'}
          disabled={!workspacePath || running}
          className="flex-1 bg-transparent text-[11px] font-mono text-gray-100 placeholder-gray-600 outline-none"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}
