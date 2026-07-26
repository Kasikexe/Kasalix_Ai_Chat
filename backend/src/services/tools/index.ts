/**
 * Tool Plugin System
 *
 * Tools are functions the AI can invoke during conversations.
 * Each tool has a name, description, param schema, and an execute function.
 */

export interface ToolParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
}

export interface ToolDefinition {
  /** Unique ID (e.g. "converter") */
  id: string;
  /** Display name (e.g. "Unit Converter") */
  name: string;
  /** Short description — tells the AI when to use this tool */
  description: string;
  /** Version */
  version: string;
  /** Emoji icon */
  icon: string;
  /** Parameter schema */
  params: ToolParam[];
}

export interface ToolContext {
  /** Free text the user sent that triggered this tool */
  userInput: string;
}

export interface ToolResult {
  /** Whether the tool succeeded */
  success: boolean;
  /** Human-readable result to inject into AI context */
  output: string;
  /** Optional raw data */
  data?: Record<string, unknown>;
}

export type ToolExecutor = (
  params: Record<string, unknown>,
  ctx: ToolContext
) => Promise<ToolResult>;

interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolExecutor;
}

// ─── Registry ─────────────────────────────────────────────

const registry = new Map<string, RegisteredTool>();

/** Register a tool so the AI pipeline can call it */
export function registerTool(definition: ToolDefinition, execute: ToolExecutor): void {
  if (registry.has(definition.id)) {
    console.warn(`[tools] Tool "${definition.id}" already registered — overwriting`);
  }
  registry.set(definition.id, { definition, execute });
  console.log(`[tools] Registered tool: ${definition.name} (${definition.id})`);
}

/** Get all registered tool definitions (for the Plugins UI) */
export function getAllTools(): ToolDefinition[] {
  return Array.from(registry.values()).map((t) => t.definition);
}

/** Execute a tool by ID */
export async function executeTool(
  toolId: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const tool = registry.get(toolId);
  if (!tool) {
    return { success: false, output: `Tool "${toolId}" is not available.` };
  }
  try {
    return await tool.execute(params, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Tool "${toolId}" error: ${msg}` };
  }
}

/**
 * Try to detect which tool the user wants based on their input text.
 * Uses keyword matching and tool-specific detection logic.
 */
export async function detectTool(input: string): Promise<{ toolId: string; params: Record<string, unknown> } | null> {
  const lower = input.toLowerCase();

  // ─── Calculator detection ─────────────────────────────
  // Only trigger when there's actual math evidence (numbers + operators), not just keywords
  const hasMathEvidence = /[\d]\s*[+\-*/^%]\s*[\d]/.test(input) || /^(calculate|compute|solve|evaluate)\s+/i.test(input.trim());
  const hasMixedNumberAndKeyword = /\d/.test(input) && /^(calculate|what (is|'s)|compute|solve|evaluate)/i.test(input.trim());
  if ((hasMathEvidence || hasMixedNumberAndKeyword) && !lower.includes('http') && !lower.includes('convert')) {
    // Delegate to the tool's own detect which has smarter pattern matching
    try {
      const { detect: calcDetect } = await import('./calculator');
      if (typeof calcDetect === 'function') {
        const result = calcDetect(input);
        if (result) {
          return { toolId: 'calculator', params: result.params };
        }
      }
    } catch {}
    // Fallback: only extract expression if there's an actual math operator present
    if (hasMathEvidence) {
      return { toolId: 'calculator', params: { expression: input.replace(/^(calculate|what (?:is|'s)|compute|solve|evaluate)\s+/i, '').trim() } };
    }
  }

  // ─── Converter detection ──────────────────────────────
  if (
    lower.includes('convert') ||
    lower.includes('conversion') ||
    lower.includes('how many') ||
    lower.includes('how much') ||
    (lower.includes('to') && (lower.includes('cm') || lower.includes('feet') || lower.includes('inch') || lower.includes('kg') || lower.includes('lb'))) ||
    lower.includes('°f') || lower.includes('°c') || lower.includes('fahrenheit') || lower.includes('celsius')
  ) {
    try {
      const { detectConversion } = await import('./converter');
      if (typeof detectConversion === 'function') {
        const result = detectConversion(input);
        if (result) {
          return {
            toolId: 'converter',
            params: { value: result.value, from: result.from, to: result.to },
          };
        }
      }
    } catch {}
    // Fallthrough — if detectConversion returned null, the input wasn't a recognized unit conversion.
    // Other tools (color, datetime, etc.) might handle it better.
  }

  // ─── Text Utilities detection ─────────────────────────
  const isTextOp =
    lower.includes('word count') || lower.includes('character count') ||
    lower.includes('uppercase') || lower.includes('lowercase') ||
    lower.includes('title case') || lower.includes('camel case') ||
    lower.includes('snake case') || lower.includes('reverse') ||
    lower.includes('base64') || lower.includes('url encode') ||
    lower.includes('url decode') || lower.includes('count words') ||
    lower.includes('text stats') || lower.includes('analyze this text') ||
    (lower.includes('count') && (lower.includes('word') || lower.includes('letter') || lower.includes('character')));
  if (isTextOp) {
    try {
      const { detectOperation } = await import('./text');
      const op = typeof detectOperation === 'function' ? detectOperation(input) : null;
      return { toolId: 'text', params: { operation: op || 'count', query: input } };
    } catch {}
    return { toolId: 'text', params: { operation: 'count', query: input } };
  }

  // ─── Color detection ──────────────────────────────────
  const hasColor = /#[0-9A-Fa-f]{3,6}\b|rgb\(|hsl\(|cmyk\(/i.test(input);
  const colorNames = ['red', 'green', 'blue', 'white', 'black', 'purple', 'orange', 'yellow', 'pink', 'brown', 'cyan', 'magenta', 'navy', 'teal', 'coral', 'gold', 'silver', 'indigo', 'violet', 'tomato'];
  const isColorRequest = hasColor || (colorNames.some((n) => lower.includes(n)) && (lower.includes('color') || lower.includes('convert') || lower.includes('hex') || lower.includes('rgb') || lower.includes('hsl') || lower.includes('cmyk')));
  if (isColorRequest && !lower.includes('convert') && !lower.includes('cm') && !lower.includes('inches')) {
    return { toolId: 'color', params: { query: input } };
  }

  // ─── Date/Time detection ──────────────────────────────
  if (/what('s| is) (the )?(current )?(time|date|day)/i.test(input) ||
      /what time is it/i.test(input) ||
      /time\s+in\s+\w{2,7}\b/i.test(input) ||
      /(\d+)\s*(day|week|month|year|hour|minute)s?\s+(from|after|ago|now)/i.test(input) ||
      /how long.*(between|from|until)/i.test(input)) {
    try {
      const { detect: dtDetect } = await import('./datetime');
      if (typeof dtDetect === 'function') {
        const result = dtDetect(input);
        if (result) return { toolId: 'datetime', params: result.params };
      }
    } catch {}
    if (/what\s+(time|date|day)/i.test(input)) {
      return { toolId: 'datetime', params: { action: 'now' } };
    }
  }

  // ─── Random detection ─────────────────────────────────
  if (/roll\s+d\d+|dice|coin\s+flip|flip\s+(a\s+)?coin/i.test(input) ||
      /generate\s+(a\s+)?password|random\s+password/i.test(lower) ||
      /generate\s+(a\s+)?uuid/i.test(lower) ||
      /random\s+(number|int)/i.test(lower) ||
      /pick\s+(a\s+)?random\s+(from|of)/i.test(lower)) {
    try {
      const { detect: randDetect } = await import('./random');
      if (typeof randDetect === 'function') {
        const result = randDetect(input);
        if (result) return { toolId: 'random', params: result.params };
      }
    } catch {}
    return { toolId: 'random', params: { action: 'number', query: input } };
  }

  // ─── JSON detection ───────────────────────────────────
  if (lower.includes('json') && (lower.includes('format') || lower.includes('validate') || lower.includes('minify') || lower.includes('prettify') || lower.includes('compress') || lower.includes('keys') || lower.includes('analyze') || lower.includes('structure'))) {
    try {
      const { detect: jsonDetect } = await import('./json');
      if (typeof jsonDetect === 'function') {
        const result = jsonDetect(input);
        if (result) return { toolId: 'json', params: result.params };
      }
    } catch {}
    return { toolId: 'json', params: { action: 'format', query: input } };
  }

  // ─── Hash detection ───────────────────────────────────
  const hashKeywords = ['md5', 'sha1', 'sha256', 'sha512', 'sha3', 'blake2', 'hmac'];
  const wantsHash = hashKeywords.some((kw) => lower.includes(kw)) &&
    (lower.includes('hash') || lower.includes('generate') || lower.includes('compute') || lower.includes('verify') || lower.includes('check'));
  if (wantsHash) {
    try {
      const { detect: hashDetect } = await import('./hash');
      if (typeof hashDetect === 'function') {
        const result = hashDetect(input);
        if (result) return { toolId: 'hash', params: result.params };
      }
    } catch {}
    return { toolId: 'hash', params: { action: 'all', query: input } };
  }

  return null;
}
