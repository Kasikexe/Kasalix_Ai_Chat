/**
 * Date/Time Tool — timezone conversion, date math, formatting, duration calculation
 */

import { registerTool } from './index';
import type { ToolDefinition, ToolExecutor } from './index';

// Common timezone offsets (minutes from UTC) for quick lookups
const TIMEZONE_OFFSETS: Record<string, number> = {
  'utc': 0, 'gmt': 0, 'z': 0,
  'est': -300, 'edt': -240,
  'cst': -360, 'cdt': -300,
  'mst': -420, 'mdt': -360,
  'pst': -480, 'pdt': -420,
  'cet': 60, 'cest': 120,
  'eet': 120, 'eest': 180,
  'msk': 180, 'ist': 330,
  'cst_china': 480, 'jst': 540, 'kst': 540,
  'aest': 600, 'aedt': 660,
  'nzst': 720, 'nzdt': 780,
  'hst': -600, 'akst': -540,
  'brt': -180, 'art': -180,
  'wast': 120, 'cat': 120, 'eat': 180,
};

const TIMEZONE_NAMES: Record<string, string> = {
  'utc': 'UTC', 'gmt': 'GMT',
  'eastern': 'EST', 'central': 'CST', 'mountain': 'MST', 'pacific': 'PST',
  'europe': 'CET', 'japan': 'JST', 'china': 'CST (China)', 'india': 'IST',
  'australia': 'AEST', 'new zealand': 'NZST', 'korea': 'KST',
  'hawaii': 'HST', 'alaska': 'AKST', 'brazil': 'BRT', 'argentina': 'ART',
};

function getOffsetMinutes(tz: string): number | null {
  const clean = tz.trim().toLowerCase().replace(/\\s+/g, '_');

  // Direct lookup
  if (clean in TIMEZONE_OFFSETS) return TIMEZONE_OFFSETS[clean];

  // Named timezone
  if (clean in TIMEZONE_NAMES) return TIMEZONE_OFFSETS[TIMEZONE_NAMES[clean].toLowerCase().split(' ')[0]] || null;

  // UTC+/- offset
  const offsetMatch = clean.match(/utc([+-]?)(\d+)(?::(\d+))?/i);
  if (offsetMatch) {
    const sign = offsetMatch[1] === '-' ? -1 : 1;
    const hours = parseInt(offsetMatch[2]);
    const mins = offsetMatch[3] ? parseInt(offsetMatch[3]) : 0;
    return sign * (hours * 60 + mins);
  }

  // Plain +/- hours
  const plainMatch = clean.match(/^([+-]?)(\d{1,2})(?::(\d{2}))?$/);
  if (plainMatch) {
    const sign = plainMatch[1] === '-' ? -1 : 1;
    const hours = parseInt(plainMatch[2]);
    const mins = plainMatch[3] ? parseInt(plainMatch[3]) : 0;
    if (hours <= 14) return sign * (hours * 60 + mins);
  }

  return null;
}

function formatDate(date: Date, format: string): string {
  const pad = (n: number, z = 2) => String(n).padStart(z, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fullMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fullDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Longer patterns must come first to avoid partial replacements (MONTH before MON, DAYFULL before DAY)
  const map: Record<string, string> = {
    'YYYY': String(date.getFullYear()),
    'YY': String(date.getFullYear()).slice(-2),
    'MONTH': fullMonths[date.getMonth()],   // must be before MON
    'MON': months[date.getMonth()],
    'MM': pad(date.getMonth() + 1),
    'DAYFULL': fullDays[date.getDay()],     // must be before DAY
    'DAY': days[date.getDay()],
    'DD': pad(date.getDate()),
    'HH': pad(date.getHours()),
    'mm': pad(date.getMinutes()),
    'ss': pad(date.getSeconds()),
    'ISO': date.toISOString(),
  };

  let result = format;
  for (const [key, val] of Object.entries(map)) {
    result = result.replace(key, val);
  }
  return result;
}

function parseDateInput(input: string): Date | null {
  input = input.trim();

  // "now" or "current"
  if (/^now|current|today$/i.test(input)) return new Date();

  // "tomorrow" or "yesterday"
  if (/^tomorrow$/i.test(input)) {
    const d = new Date(); d.setDate(d.getDate() + 1); return d;
  }
  if (/^yesterday$/i.test(input)) {
    const d = new Date(); d.setDate(d.getDate() - 1); return d;
  }

  // Try standard date parsing
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) return parsed;

  return null;
}

function dateMath(input: string): { result: Date; description: string } | null {
  const ops: { regex: RegExp; apply: (d: Date, n: number) => void; unit: string }[] = [
    { regex: /(\d+)\s*(day|days)\s+(from|after|from now|ahead)/i, apply: (d, n) => d.setDate(d.getDate() + n), unit: 'day' },
    { regex: /(\d+)\s*(day|days)\s+(before|ago|earlier|back)/i, apply: (d, n) => d.setDate(d.getDate() - n), unit: 'day' },
    { regex: /(\d+)\s*(week|weeks)\s+(from|after|from now|ahead)/i, apply: (d, n) => d.setDate(d.getDate() + n * 7), unit: 'week' },
    { regex: /(\d+)\s*(week|weeks)\s+(before|ago|earlier|back)/i, apply: (d, n) => d.setDate(d.getDate() - n * 7), unit: 'week' },
    { regex: /(\d+)\s*(month|months)\s+(from|after|from now|ahead)/i, apply: (d, n) => d.setMonth(d.getMonth() + n), unit: 'month' },
    { regex: /(\d+)\s*(month|months)\s+(before|ago|earlier|back)/i, apply: (d, n) => d.setMonth(d.getMonth() - n), unit: 'month' },
    { regex: /(\d+)\s*(year|years)\s+(from|after|from now|ahead)/i, apply: (d, n) => d.setFullYear(d.getFullYear() + n), unit: 'year' },
    { regex: /(\d+)\s*(year|years)\s+(before|ago|earlier|back)/i, apply: (d, n) => d.setFullYear(d.getFullYear() - n), unit: 'year' },
    { regex: /(\d+)\s*(hour|hours)\s+(from now|ahead|later)/i, apply: (d, n) => d.setHours(d.getHours() + n), unit: 'hour' },
    { regex: /(\d+)\s*(hour|hours)\s+ago/i, apply: (d, n) => d.setHours(d.getHours() - n), unit: 'hour' },
    { regex: /(\d+)\s*(minute|minutes|min|mins)\s+(from now|ahead|later)/i, apply: (d, n) => d.setMinutes(d.getMinutes() + n), unit: 'minute' },
    { regex: /(\d+)\s*(minute|minutes|min|mins)\s+ago/i, apply: (d, n) => d.setMinutes(d.getMinutes() - n), unit: 'minute' },
  ];

  for (const op of ops) {
    const m = input.match(op.regex);
    if (m) {
      const d = new Date();
      const n = parseInt(m[1]);
      op.apply(d, n);
      return { result: d, description: `${n} ${op.unit}${n !== 1 ? 's' : ''} ${d > new Date() ? 'from now' : 'ago'}` };
    }
  }
  return null;
}

function durationBetween(d1: Date, d2: Date): string {
  const ms = Math.abs(d2.getTime() - d1.getTime());
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30.44);
  const years = Math.floor(days / 365.25);

  const parts: string[] = [];
  if (years > 0) parts.push(`${years} year${years !== 1 ? 's' : ''}`);
  if (months > 0) parts.push(`${months} month${months !== 1 ? 's' : ''}`);
  if (weeks > 0 && years === 0) parts.push(`${weeks} week${weeks !== 1 ? 's' : ''}`);
  if (days > 0 && months === 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
  if (hours > 0 && days === 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
  if (minutes > 0 && hours === 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
  if (seconds < 60) parts.push(`${seconds} second${seconds !== 1 ? 's' : ''}`);

  return parts.join(', ') || '0 seconds';
}

const definition: ToolDefinition = {
  id: 'datetime',
  name: 'Date & Time',
  description: 'Current time in any timezone, date math (what is 2 weeks from now?), timezone conversion, duration calculation, date formatting',
  version: '1.0.0',
  icon: '🕐',
  params: [
    { name: 'action', type: 'string', description: 'Action: now, convert, math, duration, format', required: true },
    { name: 'date', type: 'string', description: 'Date/time string to process', required: false },
    { name: 'from', type: 'string', description: 'Source timezone (e.g., UTC, EST, PST, CET)', required: false },
    { name: 'to', type: 'string', description: 'Target timezone (e.g., UTC, EST, PST, CET)', required: false },
    { name: 'format', type: 'string', description: 'Output format: ISO, YYYY-MM-DD, readable, or custom', required: false },
  ],
};

const execute: ToolExecutor = async (params, ctx) => {
  const action = String(params.action || 'now').toLowerCase();
  const userInput = String(params.query || ctx.userInput || '');
  const dateStr = String(params.date || '');
  const fromTz = String(params.from || '').trim();
  const toTz = String(params.to || '').trim();
  const format = String(params.format || 'readable').toLowerCase();

  const now = new Date();

  switch (action) {
    case 'now':
    case 'current':
    case 'time': {
      const offset = toTz ? getOffsetMinutes(toTz) : null;
      if (offset !== null && offset !== undefined) {
        const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
        const tzDate = new Date(utcMs + offset * 60000);
        return {
          success: true,
          output: `Current time in ${toTz.toUpperCase()}: ${formatDate(tzDate, format === 'iso' ? 'ISO' : 'YYYY-MM-DD HH:mm:ss')}`,
          data: { timezone: toTz.toUpperCase(), datetime: tzDate.toISOString(), offset: offset },
        };
      }
      return {
        success: true,
        output: `Current time: ${formatDate(now, 'YYYY-MM-DD HH:mm:ss')} (local)\nUTC: ${formatDate(now, 'ISO')}`,
        data: { local: now.toISOString(), utc: now.toUTCString(), timestamp: now.getTime() },
      };
    }

    case 'convert':
    case 'tz':
    case 'timezone': {
      const srcOffset = fromTz ? getOffsetMinutes(fromTz) : -now.getTimezoneOffset();
      const dstOffset = getOffsetMinutes(toTz);
      if (dstOffset === null || dstOffset === undefined) {
        return { success: false, output: `Unknown timezone "${toTz}". Try: UTC, EST, PST, CET, JST, or UTC+5` };
      }

      let srcDate: Date;
      if (dateStr) {
        const parsed = parseDateInput(dateStr);
        if (!parsed) return { success: false, output: `Could not parse date "${dateStr}".` };
        srcDate = parsed;
      } else {
        srcDate = now;
      }

      const diff = dstOffset - srcOffset;
      const resultDate = new Date(srcDate.getTime() + diff * 60000);
      const fromLabel = fromTz || 'local';
      const toLabel = toTz.toUpperCase();

      return {
        success: true,
        output: `${formatDate(srcDate, 'YYYY-MM-DD HH:mm:ss')} ${fromLabel} → ${formatDate(resultDate, 'YYYY-MM-DD HH:mm:ss')} ${toLabel}`,
        data: { from: fromLabel, to: toLabel, input: srcDate.toISOString(), result: resultDate.toISOString(), offset: diff },
      };
    }

    case 'math':
    case 'add':
    case 'subtract':
    case 'calc': {
      const mathResult = dateMath(userInput || dateStr);
      if (mathResult) {
        return {
          success: true,
          output: `${mathResult.description}: ${formatDate(mathResult.result, 'YYYY-MM-DD HH:mm:ss')} (${formatDate(mathResult.result, 'DAYFULL')})`,
          data: { result: mathResult.result.toISOString(), description: mathResult.description },
        };
      }
      return { success: false, output: `Could not parse date math. Try: "2 weeks from now", "3 days ago", "1 month from now"` };
    }

    case 'duration':
    case 'between':
    case 'diff':
    case 'difference': {
      // Expect two dates separated by "and" or "to" or " - "
      const parts = userInput.split(/\s+(?:and|to|until)\s+|\s*[-–]\s*/i);
      if (parts.length >= 2) {
        const d1 = parseDateInput(parts[0].trim());
        const d2 = parseDateInput(parts[1].trim());
        if (d1 && d2) {
          const dur = durationBetween(d1, d2);
          return {
            success: true,
            output: `Between ${formatDate(d1, 'YYYY-MM-DD')} and ${formatDate(d2, 'YYYY-MM-DD')}: ${dur}`,
            data: { from: d1.toISOString(), to: d2.toISOString(), duration: dur },
          };
        }
      }
      // Try "X days/hours between dates"
      return { success: false, output: 'Provide two dates: "Jan 1, 2024 and Mar 15, 2024" or "today and tomorrow"' };
    }

    case 'format':
    case 'strftime': {
      const dateToFormat = dateStr ? (parseDateInput(dateStr) || new Date(dateStr)) : now;
      if (isNaN(dateToFormat.getTime())) {
        return { success: false, output: `Could not parse date "${dateStr}".` };
      }
      const formatted = formatDate(dateToFormat, format === 'iso' ? 'ISO' : format.toUpperCase());
      return {
        success: true,
        output: formatted,
        data: { input: dateToFormat.toISOString(), formatted, format },
      };
    }

    default:
      return {
        success: false,
        output: `Unknown action "${action}". Available: now, convert, math, duration, format`,
      };
  }
};

function detect(input: string): { confidence: number; params: Record<string, unknown> } | null {
  const lower = input.toLowerCase();

  // Current time
  if (/what('s| is) (the )?(current )?(time|date|day|hour)/i.test(input)) {
    return { confidence: 0.9, params: { action: 'now' } };
  }
  if (/what time is it/i.test(input)) {
    return { confidence: 0.95, params: { action: 'now' } };
  }

  // Timezone conversion
  if (/time\s+in\s+\w{2,5}/i.test(input) || /convert.*time/i.test(input) || /what.*time.*in/i.test(input)) {
    const tzMatch = input.match(/(?:in|to)\s+(\w{2,7})\b/i);
    return {
      confidence: 0.7,
      params: { action: 'now', to: tzMatch ? tzMatch[1] : 'UTC' },
    };
  }

  // Date math
  if (/(\d+)\s*(day|week|month|year|hour|minute)s?\s+(from|after|ago|before|now)/i.test(input)) {
    return { confidence: 0.85, params: { action: 'math', query: input } };
  }

  // Duration
  if (/(?:how long|duration|time between|difference between)/i.test(input)) {
    return { confidence: 0.7, params: { action: 'duration', query: input } };
  }

  return null;
}

export function registerDateTimeTool(): void {
  registerTool(definition, execute);
  console.log('[tools] Date & Time registered');
}
