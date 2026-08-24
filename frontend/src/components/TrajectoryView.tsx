/**
 * Trajectory View — displays the session log event timeline.
 *
 * Inspired by DeepSeek Harness's trajectory panel: every model-visible token
 * is shown with color-coded layers — tool calls in orange, context in green,
 * thinking in purple, plan in blue.
 *
 * This component can be embedded in the server GUI or used standalone.
 */

import React, { useState, useEffect, useCallback } from 'react';

// ─── Event types (mirrors backend session-log.ts) ──────────────────────

interface SessionEvent {
 ts: string;
 seq: number;
 type: string;
 label?: string;
 content?: string;
 role?: string;
 modelVisible?: boolean;
 durationMs?: number;
 meta?: Record<string, unknown>;
}

// ─── Color mapping by event type ────────────────────────────────────────

const EVENT_STYLES: Record<string, { bg: string; border: string; icon: string; label: string }> = {
 'run:start': { bg: 'bg-emerald-900/20', border: 'border-[#1a3a33]', icon: '▶️', label: 'Run Started' },
 'run:end': { bg: 'bg-emerald-900/20', border: 'border-[#1a3a33]', icon: '⏹️', label: 'Run Ended' },
 'message': { bg: 'bg-gray-800/40', border: 'border-gray-700/50', icon: '💬', label: 'Message' },
 'tool:call': { bg: 'bg-orange-900/20', border: 'border-orange-700/50', icon: '🔧', label: 'Tool Call' },
 'tool:result': { bg: 'bg-[#1a1610]', border: 'border-[#5a4a30]', icon: '📋', label: 'Tool Result' },
 'plan': { bg: 'bg-[#0e1a28]', border: 'border-[#2a3a52]', icon: '📝', label: 'Plan' },
 'plan:update': { bg: 'bg-[#0e1a28]', border: 'border-[#2a3a52]', icon: '✅', label: 'Plan Update' },
 'verify': { bg: 'bg-green-900/20', border: 'border-green-700/50', icon: '🔍', label: 'Verification' },
 'thinking': { bg: 'bg-purple-900/20', border: 'border-[#2a3a52]', icon: '🧠', label: 'Thinking' },
 'stage': { bg: 'bg-sky-900/20', border: 'border-sky-700/50', icon: '🔄', label: 'Stage' },
 'error': { bg: 'bg-red-900/20', border: 'border-[#5a3030]', icon: '❌', label: 'Error' },
};

// ─── Props ──────────────────────────────────────────────────────────────

interface TrajectoryViewProps {
 events: SessionEvent[];
 /** If true, auto-scroll to bottom as new events arrive */
 live?: boolean;
 /** Compact mode — only show tool calls and results, skip messages */
 compact?: boolean;
}

// ─── Component ──────────────────────────────────────────────────────────

export const TrajectoryView: React.FC<TrajectoryViewProps> = ({ events, live = false, compact = false }) => {
 const containerRef = React.useRef<HTMLDivElement>(null);
 const [expandedSeq, setExpandedSeq] = useState<number | null>(null);

 // Auto-scroll to bottom when live
 useEffect(() => {
 if (live && containerRef.current) {
 containerRef.current.scrollTop = containerRef.current.scrollHeight;
 }
 }, [events.length, live]);

 const toggleExpand = useCallback((seq: number) => {
 setExpandedSeq((prev) => (prev === seq ? null : seq));
 }, []);

 // Filter events in compact mode
 const filtered = compact
 ? events.filter((e) => e.type === 'tool:call' || e.type === 'tool:result' || e.type === 'plan' || e.type === 'error' || e.type === 'run:start' || e.type === 'run:end')
 : events;

 if (filtered.length === 0) {
 return (
 <div className="text-center py-8 text-gray-500 text-sm">
 No trajectory data yet. Run a Koding session to see events here.
 </div>
 );
 }

 return (
 <div ref={containerRef} className="space-y-2 max-h-[600px] overflow-y-auto pr-2">
 {filtered.map((event) => {
 const style = EVENT_STYLES[event.type] || EVENT_STYLES['message'];
 const isExpanded = expandedSeq === event.seq;
 const hasContent = event.content && event.content.length > 0;
 const contentPreview = event.content
 ? event.content.length > 120
 ? event.content.slice(0, 120) + '…'
 : event.content
 : '';

 return (
 <div
 key={event.seq}
 className={`${style.bg} border ${style.border} rounded-lg p-3 transition-all duration-200`}
 >
 {/* Header */}
 <div className="flex items-center gap-2 mb-1">
 <span className="text-sm">{style.icon}</span>
 <span className="text-xs font-medium text-gray-300">{style.label}</span>
 {event.label && (
 <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700/50 text-gray-400 font-mono">
 {event.label}
 </span>
 )}
 {event.role && (
 <span className={`text-xs px-1.5 py-0.5 rounded ${
 event.role === 'assistant' ? 'bg-sky-800/50 text-sky-300' :
 event.role === 'user' ? 'bg-green-800/50 text-green-300' :
 'bg-purple-800/50 text-[#9bb8d6]'
 }`}>
 {event.role}
 </span>
 )}
 {event.meta?.ok === false && (
 <span className="text-xs px-1.5 py-0.5 rounded bg-red-800/50 text-[#d66]">failed</span>
 )}
 {event.meta?.passed === false && (
 <span className="text-xs px-1.5 py-0.5 rounded bg-red-800/50 text-[#d66]">failed</span>
 )}
 <span className="text-[10px] text-gray-600 ml-auto font-mono">
 {new Date(event.ts).toLocaleTimeString()}
 </span>
 </div>

 {/* Content preview */}
 {hasContent && (
 <div
 className="text-xs text-gray-400 font-mono whitespace-pre-wrap cursor-pointer hover:text-gray-300 transition-colors"
 onClick={() => hasContent && toggleExpand(event.seq)}
 >
 {isExpanded ? (
 <pre className="mt-2 p-2 bg-gray-900/50 rounded text-[11px] max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
 {event.content}
 </pre>
 ) : (
 <span>{contentPreview}</span>
 )}
 </div>
 )}
 </div>
 );
 })}
 </div>
 );
};

export default TrajectoryView;
