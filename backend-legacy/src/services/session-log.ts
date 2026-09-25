/**
 * Session Log — append-only event stream for Koding agent runs.
 *
 * Every token the model sees is recorded. This is the source of truth for
 * trajectory view, resume, fork, and audit. Follows DeepSeek Harness's
 * principle: "Model-visible means recorded."
 */

import { promises as fs } from 'fs';
import path from 'path';
import { getDataDir } from '../utils/helpers';
import { logger } from './logger';

// ─── Event types ────────────────────────────────────────────────────────

export type SessionEventType =
  | 'run:start'
  | 'run:end'
  | 'turn:start'
  | 'turn:end'
  | 'message'
  | 'tool:call'
  | 'tool:result'
  | 'plan'
  | 'plan:update'
  | 'verify'
  | 'thinking'
  | 'error'
  | 'stage';

export interface SessionEvent {
  /** ISO timestamp */
  ts: string;
  /** Monotonic sequence number within the run */
  seq: number;
  /** Event type */
  type: SessionEventType;
  /** Free-form label (e.g. tool name, stage name) */
  label?: string;
  /** The model-visible content (message content, tool call JSON, tool result) */
  content?: string;
  /** Role for message events */
  role?: 'system' | 'user' | 'assistant';
  /** Whether this content was actually sent to the model */
  modelVisible?: boolean;
  /** Duration in ms for timing-sensitive events */
  durationMs?: number;
  /** Extra metadata */
  meta?: Record<string, unknown>;
}

// ─── Session log writer ─────────────────────────────────────────────────

export class SessionLog {
  private filePath: string;
  private seq = 0;
  private runId: string;
  private startedAt: string;

  constructor(runId?: string) {
    this.runId = runId || `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.startedAt = new Date().toISOString();
    const dataDir = getDataDir();
    this.filePath = path.join(dataDir, 'session-logs', `${this.runId}.jsonl`);
  }

  /** Initialize the log file and write run:start event. */
  async init(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      // Write run:start
      await this.append({
        ts: this.startedAt,
        type: 'run:start',
        meta: { runId: this.runId },
      });
    } catch (e) {
      logger.error(`[session-log] Failed to init: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Append an event to the log file. Fire-and-forget — never blocks the pipeline. */
  async append(event: Omit<SessionEvent, 'seq'>): Promise<void> {
    const full: SessionEvent = { ...event, seq: this.nextSeq() };
    try {
      await fs.appendFile(this.filePath, JSON.stringify(full) + '\n', 'utf-8');
    } catch (e) {
      logger.error(`[session-log] Failed to append: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Record a message the model saw (or will see). */
  async logMessage(role: 'system' | 'user' | 'assistant', content: string, metaVisible = true): Promise<void> {
    // Truncate very long content to keep the log manageable
    const truncated = content.length > 50_000 ? content.slice(0, 50_000) + '\n...[truncated in log]' : content;
    await this.append({
      ts: new Date().toISOString(),
      type: 'message',
      role,
      content: truncated,
      modelVisible: metaVisible,
    });
  }

  /** Record a tool call the model made. */
  async logToolCall(tool: string, args: Record<string, unknown>): Promise<void> {
    await this.append({
      ts: new Date().toISOString(),
      type: 'tool:call',
      label: tool,
      content: JSON.stringify({ tool, args }),
    });
  }

  /** Record a tool result fed back to the model. */
  async logToolResult(tool: string, output: string, ok: boolean): Promise<void> {
    const truncated = output.length > 20_000 ? output.slice(0, 20_000) + '\n...[truncated in log]' : output;
    await this.append({
      ts: new Date().toISOString(),
      type: 'tool:result',
      label: tool,
      content: truncated,
      meta: { ok },
    });
  }

  /** Record a plan the model created. */
  async logPlan(plan: string, meta?: Record<string, unknown>): Promise<void> {
    await this.append({
      ts: new Date().toISOString(),
      type: 'plan',
      content: plan,
      meta,
    });
  }

  /** Record a plan update (step completed, step added). */
  async logPlanUpdate(update: string, meta?: Record<string, unknown>): Promise<void> {
    await this.append({
      ts: new Date().toISOString(),
      type: 'plan:update',
      content: update,
      meta,
    });
  }

  /** Record a verification run. */
  async logVerify(command: string, output: string, passed: boolean): Promise<void> {
    const truncated = output.length > 5_000 ? output.slice(0, 5_000) + '\n...[truncated]' : output;
    await this.append({
      ts: new Date().toISOString(),
      type: 'verify',
      label: command,
      content: truncated,
      meta: { passed },
    });
  }

  /** Record a stage change. */
  async logStage(stage: string): Promise<void> {
    await this.append({
      ts: new Date().toISOString(),
      type: 'stage',
      label: stage,
    });
  }

  /** Record the end of a run. */
  async end(): Promise<void> {
    await this.append({
      ts: new Date().toISOString(),
      type: 'run:end',
      meta: { runId: this.runId },
    });
  }

  /** Read all events from the log file. */
  async readAll(): Promise<SessionEvent[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return raw
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as SessionEvent);
    } catch {
      return [];
    }
  }

  /** Reconstruct the model-visible history from the log. */
  async rebuildHistory(): Promise<{ role: string; content: string }[]> {
    const events = await this.readAll();
    const messages: { role: string; content: string }[] = [];
    for (const e of events) {
      if (e.type === 'message' && e.role && e.content) {
        messages.push({ role: e.role, content: e.content });
      }
    }
    return messages;
  }

  /** Get the run ID. */
  getRunId(): string {
    return this.runId;
  }

  /** Get the log file path. */
  getFilePath(): string {
    return this.filePath;
  }

  private nextSeq(): number {
    return ++this.seq;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** List all session log files, sorted by most recent first. */
export async function listSessionLogs(): Promise<{ runId: string; filePath: string; mtime: string }[]> {
  try {
    const dataDir = getDataDir();
    const logDir = path.join(dataDir, 'session-logs');
    const files = await fs.readdir(logDir);
    const logs: { runId: string; filePath: string; mtime: string }[] = [];
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(logDir, f);
      const stat = await fs.stat(full);
      logs.push({
        runId: f.replace('.jsonl', ''),
        filePath: full,
        mtime: stat.mtime.toISOString(),
      });
    }
    return logs.sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {
    return [];
  }
}

/** Read a specific session log by run ID. */
export async function readSessionLog(runId: string): Promise<SessionEvent[]> {
  const dataDir = getDataDir();
  const filePath = path.join(dataDir, 'session-logs', `${runId}.jsonl`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as SessionEvent);
  } catch {
    return [];
  }
}
