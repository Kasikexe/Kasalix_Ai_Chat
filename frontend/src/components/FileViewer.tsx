import { useState, useEffect, useRef, useMemo } from 'react';
import { X } from 'lucide-react';
import { api } from '../services/api';

interface Props {
  filePath: string;
  workspacePath: string;
  onClose: () => void;
}

/** Colored SVG file-type badge — no emoji, per-file-type hue. */
function FileTypeIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const kinds: Record<string, [string, string]> = {
    ts: ['#3178c6', 'TS'], tsx: ['#3178c6', 'TS'], js: ['#f7df1e', 'JS'], jsx: ['#f7df1e', 'JS'],
    mjs: ['#f7df1e', 'JS'], py: ['#3572A5', 'PY'], json: ['#cbcb41', '{}'], md: ['#8a919f', 'M'],
    html: ['#e34c26', '<>'], css: ['#563d7c', '#'], scss: ['#c6538c', '#'], svg: ['#ffb13b', 'S'],
    png: ['#41a85f', 'IMG'], jpg: ['#41a85f', 'IMG'], jpeg: ['#41a85f', 'IMG'], gif: ['#41a85f', 'IMG'],
    ico: ['#41a85f', 'IMG'], txt: ['#8a919f', 'T'], rs: ['#dea584', 'RS'], go: ['#00ADD8', 'GO'],
    java: ['#b07219', 'J'], c: ['#555555', 'C'], cpp: ['#f34b7d', 'C++'], sh: ['#89e051', '$'],
  };
  const [color, label] = kinds[ext] || ['#6b7280', ext.slice(0, 3).toUpperCase() || '?'];
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className="flex-shrink-0">
      <rect x="1" y="1" width="14" height="14" rx="3" fill={color} opacity="0.22" stroke={color} strokeWidth="1"/>
      <text x="8" y="11" textAnchor="middle" fontSize="6.5" fontWeight="700" fill={color} fontFamily="monospace">{label}</text>
    </svg>
  );
}

/** A file opened from the workspace tree — read-only viewer with basic highlighting. */
export function FileViewer({ filePath, workspacePath, onClose }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath;

  useEffect(() => {
    let cancelled = false;
    setContent(null); setError(null); setBinary(false);
    (async () => {
      try {
        const r = await api.getFileContent(filePath, workspacePath);
        if (cancelled) return;
        if (r.binary) { setBinary(true); setContent(null); return; }
        setContent(r.content ?? '');
        setTruncated(!!r.truncated);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load file');
      }
    })();
    return () => { cancelled = true; };
  }, [filePath, workspacePath]);

  // Basic token coloring — cheap, memoized, no external highlighter.
  const rendered = useMemo(() => {
    if (content === null) return null;
    const lines = content.split('\n');
    return lines.map((line, i) => {
      const commented = /^\s*(#|\/\/|\/\*|\*)/.test(line);
      const isKeyword = /\b(import|from|def|class|return|if|elif|else|for|while|try|except|const|let|var|function|async|await|export|new|public|private|void|int|str|float|bool|True|False|None|true|false|null)\b/.test(line);
      const strCount = (line.match(/(["'])(?:(?=(\\?))\2.)*?\1/g) || []).length;
      return (
        <div key={i} className="flex hover:bg-white/[0.03]">
          <span className="select-none text-right pr-3 pl-3 text-gray-600 text-[10px] leading-[1.55] w-12 flex-shrink-0 tabular-nums">{i + 1}</span>
          <span
            className={`flex-1 text-[11px] leading-[1.55] font-mono ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}
            style={{ color: commented ? '#6a9955' : isKeyword ? '#c586c0' : strCount % 2 === 1 && /(["'])/.test(line) ? '#ce9178' : '#d4d4d4' }}
          >
            {line || ' '}
          </span>
        </div>
      );
    });
  }, [content, wrap]);

  return (
    <div className="w-full h-full flex flex-col bg-[#0d1117]">
      {/* Tab-style header */}
      <div className="flex items-center border-b border-gray-800 bg-gray-900/70">
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0d1117] border-r border-t border-gray-800 border-t-transparent text-[11px] text-gray-200 max-w-[60%]">
          <FileTypeIcon name={fileName} />
          <span className="truncate font-mono">{fileName}</span>
          <button onClick={onClose} className="ml-1 p-0.5 rounded hover:bg-gray-800 text-gray-500 hover:text-gray-200 transition-colors">
            <X size={11} />
          </button>
        </div>
        <div className="flex-1" />
        {content !== null && (
          <button
            onClick={() => setWrap((v) => !v)}
            className={`mr-2 px-1.5 py-0.5 rounded text-[10px] transition-colors ${wrap ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
            title="Toggle word wrap"
          >
            wrap
          </button>
        )}
      </div>

      {/* Body */}
      <div ref={bodyRef} className="flex-1 overflow-auto">
        {error && (
          <div className="p-4 text-[11px] text-[#c44] font-mono">{error}</div>
        )}
        {binary && (
          <div className="p-4 text-[11px] text-gray-500">Binary file — preview not available.</div>
        )}
        {content === null && !error && !binary && (
          <div className="p-4 text-[11px] text-gray-500 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-pulse" /> Loading…
          </div>
        )}
        {rendered}
        {truncated && (
          <div className="px-3 py-2 text-[10px] text-amber-500/80 border-t border-gray-800">
            File is large — only the first 1 MB is shown.
          </div>
        )}
      </div>
    </div>
  );
}
