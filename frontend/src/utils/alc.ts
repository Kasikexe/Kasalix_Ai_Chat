import type { AlcEventKind, AlcStreamEvent } from '../types';

/**
 * Turns a raw `alc:*` stream event into the one-line step shown in the message
 * timeline. Keeping the wording here (rather than in the hook) means the whole
 * ALC vocabulary lives in one place and a future step degrades to a readable row
 * instead of disappearing.
 *
 * `null` means "no timeline row": progress-only events such as `alc:stage`
 * drive the status line instead, and `alc:budget` only matters when it carries
 * something new.
 */
export interface AlcStep {
  kind: AlcEventKind;
  label: string;
  detail?: string;
  /** false paints the row as a failure/no-result step */
  ok?: boolean;
}

/** Status-line text per ALC stage (Message.tsx's stage line). */
export const ALC_STAGE_LABELS: Record<string, string> = {
  'alc:analyzing': 'ALC — reading the task',
  'alc:indexing': 'ALC — indexing documentation',
  'alc:gathering': 'ALC — gathering information',
  'alc:answering': 'ALC — answering from the evidence',
  // Runs AFTER the answer has streamed: writing up what was learned must never
  // hold the reply back.
  'alc:studying': 'ALC — writing up what it learned',
};

/** Human name for an ALC source, so the timeline never shows a raw tool id. */
export function alcSourceLabel(tool: string): string {
  switch (tool) {
    case 'docs_search': return 'the documentation';
    case 'docs_open': return 'a document';
    case 'knowledge_search': return 'project knowledge';
    case 'knowledge_write': return 'project knowledge';
    case 'web_search': return 'the web';
    case 'read_url': return 'a page';
    default: return tool || 'a source';
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function short(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `alc:finding` → `finding` (the switch below works on the bare kind). */
export function alcKind(type: string): AlcEventKind {
  return (str(type).replace(/^alc:/, '') || 'notice') as AlcEventKind;
}

/** A `budget`/`done` summary line: "2 cycles · 3 lookups · 4 findings · 1.2k tokens". */
export function formatAlcSummary(data: Record<string, unknown>): string {
  const parts: string[] = [];
  const cycles = count(data.cycles);
  const calls = count(data.toolCalls);
  const findings = count(data.findings);
  const tokens = count(data.tokens);
  if (cycles) parts.push(plural(cycles, 'cycle', 'cycles'));
  if (calls) parts.push(plural(calls, 'lookup', 'lookups'));
  parts.push(plural(findings, 'finding', 'findings'));
  if (tokens) parts.push(`~${tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : tokens} tokens`);
  const gaps = strings(data.gaps);
  if (gaps.length) parts.push(plural(gaps.length, 'gap', 'gaps'));
  return parts.join(' · ');
}

export function describeAlcEvent(event: AlcStreamEvent): AlcStep | null {
  const kind = alcKind(event.type);
  const data = event as Record<string, unknown>;

  switch (kind) {
    case 'stage':
      // Drives the status line only — a row per stage would be pure noise.
      return null;

    case 'start': {
      const tools = strings(data.tools).map(alcSourceLabel);
      const decideModel = str(data.decideModel);
      const bits = [
        data.model ? `model ${str(data.model)}` : '',
        // Says plainly when the cycle's own decisions came from the software
        // rather than the model — the difference is visible in the answer's cost.
        decideModel === 'heuristics-only' ? 'decisions: software heuristics' : '',
        count(data.roots) ? plural(count(data.roots), 'documentation folder') : 'no documentation folders',
        data.webEnabled ? 'web search on' : 'web search off',
        tools.length ? `sources: ${tools.join(', ')}` : '',
      ].filter(Boolean);
      return { kind, label: 'ALC cycle started', detail: `${bits.join(' · ')}\nmax: ${count(data.maxCycles)} cycles · ${count(data.maxToolCalls)} lookups · ${count(data.maxTokens)} tokens`, ok: true };
    }

    case 'goal': {
      const questions = strings(data.questions);
      const detail = [
        questions.length ? `Open questions:\n- ${questions.join('\n- ')}` : '',
        data.fallback ? '(intake decided by the software, not the model)' : '',
      ].filter(Boolean).join('\n');
      return {
        kind,
        label: `Goal: ${short(str(data.goal)) || 'the task as asked'}`,
        detail: detail || undefined,
      };
    }

    case 'decision': {
      const action = str(data.action);
      const reason = str(data.reason);
      const requested = str(data.requested);
      const notes = [
        reason,
        data.fallback ? '(decided by the software, not the model)' : '',
        requested ? `the model asked for "${requested}", which is not available` : '',
      ].filter(Boolean).join('\n');
      if (action === 'tool') {
        return { kind, label: `Decided to search ${alcSourceLabel(str(data.tool))}`, detail: notes || undefined, ok: true };
      }
      return {
        kind,
        label: data.forced ? 'Stopped gathering' : 'Decided the evidence is enough',
        detail: notes || undefined,
        ok: true,
      };
    }

    case 'search': {
      const query = short(str(data.query));
      const extra = [
        data.substituted ? '(the model gave no query — the open question was used)' : '',
        str(data.args) ? `args: ${short(str(data.args), 200)}` : '',
      ].filter(Boolean).join('\n');
      return { kind, label: `Searching ${alcSourceLabel(str(data.tool))} for “${query}”`, detail: extra || undefined, ok: true };
    }

    case 'result': {
      if (!data.ok) {
        const error = str(data.error) || 'no usable result';
        const retrying = str(data.retrying);
        return {
          kind,
          label: `No usable result from ${alcSourceLabel(str(data.tool))}`,
          detail: `${error}${retrying ? `\nretrying with “${retrying}”` : ''}`,
          ok: false,
        };
      }
      const items = count(data.count);
      const chars = count(data.chars);
      return {
        kind,
        label: `${alcSourceLabel(str(data.tool))} returned ${plural(items, 'result')}`,
        detail: chars ? `~${chars.toLocaleString()} characters to judge` : undefined,
        ok: true,
      };
    }

    case 'finding':
      return {
        kind,
        label: `Kept: ${str(data.source) || 'a passage'}`,
        detail: [str(data.reason), short(str(data.text), 400)].filter(Boolean).join('\n'),
        ok: true,
      };

    case 'conflict': {
      const names = strings(data.names);
      return {
        kind,
        label: `${plural(count(data.count), 'contradiction')} in the sources — resolved by software`,
        detail: [
          names.length ? `Same name, different values:\n- ${names.join('\n- ')}` : '',
          'The documentation outranks a web page, a project note never overrules the documentation it summarises, and within one kind the newer date wins.',
        ].filter(Boolean).join('\n'),
        ok: true,
      };
    }

    case 'verify': {
      const blocked = count(data.blocked);
      const claims = strings(data.claims);
      if (data.enabled === false) {
        return {
          kind,
          label: 'Answer check off for this run',
          detail: 'Whatever the model said was released as written.',
          ok: false,
        };
      }
      if (!blocked) {
        return { kind, label: 'Answer checked against the evidence', ok: true };
      }
      // The sentence carrying these was NOT sent: the user never read a value no
      // source states. Saying what was withheld is the honest report of that.
      return {
        kind,
        label: `${plural(blocked, 'passage')} withheld — the sources do not state it`,
        detail: [
          claims.length ? `Not in any source I searched: ${claims.join(', ')}` : '',
          'I said plainly that it could not be verified instead of stating it.',
        ].filter(Boolean).join('\n'),
        ok: false,
      };
    }

    case 'reject':
      return {
        kind,
        label: `Dropped: ${str(data.source) || 'a result'}`,
        detail: str(data.reason) || undefined,
        ok: false,
      };

    case 'gap':
      return { kind, label: `Still unknown: ${short(str(data.gap))}`, ok: false };

    case 'index': {
      const phase = str(data.phase);
      if (phase === 'start') return { kind, label: `Indexing ${plural(count(data.roots), 'documentation folder')}`, ok: true };
      if (phase === 'done') {
        return {
          kind,
          label: `Indexed ${plural(count(data.files), 'file')}`,
          detail: `${plural(count(data.chunks), 'passage')}${count(data.skipped) ? ` · ${count(data.skipped)} unchanged` : ''}${count(data.errors) ? ` · ${count(data.errors)} unreadable` : ''}`,
          ok: true,
        };
      }
      return null; // progress ticks would flood the timeline
    }

    case 'knowledge-written':
      return {
        kind,
        label: `Remembered “${str(data.topic) || 'a note'}” for later sessions`,
        detail: [str(data.file), str(data.source) ? `from ${short(str(data.source), 120)}` : ''].filter(Boolean).join('\n') || undefined,
        ok: true,
      };

    case 'study': {
      const topic = str(data.topic) || 'the topic';
      const dropped = count(data.dropped);
      const conflicts = count(data.conflicts);
      if (str(data.mode) !== 'synthesised') {
        // The model wrote something the sources did not support, so the kept
        // excerpt was stored instead. Saying why is the honest thing to show.
        return {
          kind,
          label: `Kept the excerpt for “${topic}” instead of a written-up note`,
          detail: str(data.reason) || undefined,
          ok: false,
        };
      }
      const bits = [
        plural(count(data.bullets), 'fact'),
        count(data.sources) ? `from ${plural(count(data.sources), 'source')}` : '',
        dropped ? `${plural(dropped, 'unsourced line')} removed by software` : '',
        conflicts ? `${plural(conflicts, 'conflicting source')} recorded` : '',
        data.changed === false ? 'unchanged' : '',
      ].filter(Boolean);
      return {
        kind,
        label: `Wrote up “${topic}” for later sessions`,
        detail: [str(data.file), bits.join(' · ')].filter(Boolean).join('\n') || undefined,
        ok: true,
      };
    }

    case 'done':
      return { kind, label: 'ALC cycle finished', detail: formatAlcSummary(data) || undefined, ok: true };

    case 'notice': {
      const notices: Record<string, string> = {
        'no-sources': 'ALC is on but has nothing to search',
        'read-only': 'ALC kept this session read-only',
        'unsupported-turn': 'ALC cannot run for this kind of turn',
      };
      return { kind, label: notices[str(data.kind)] || 'ALC notice', detail: str(data.message) || undefined, ok: false };
    }

    default:
      return { kind, label: 'ALC step', detail: str(data.message) || undefined };
  }
}
