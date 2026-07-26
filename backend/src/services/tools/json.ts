/**
 * JSON Tool — format, validate, minify, and prettify JSON data
 */

import { registerTool } from './index';
import type { ToolDefinition, ToolExecutor } from './index';

function formatJSON(input: string, indent: number): string {
  const parsed = JSON.parse(input);
  return JSON.stringify(parsed, null, indent);
}

function minifyJSON(input: string): string {
  const parsed = JSON.parse(input);
  return JSON.stringify(parsed);
}

function validateJSON(input: string): { valid: boolean; error?: string; type?: string } {
  try {
    const parsed = JSON.parse(input);
    const type = Array.isArray(parsed) ? 'array' : typeof parsed;
    return { valid: true, type };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : 'Invalid JSON' };
  }
}

function extractKeys(input: string): string[] {
  const parsed = JSON.parse(input);
  const keys = new Set<string>();
  function walk(obj: unknown, prefix: string) {
    if (obj && typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        keys.add(fullKey);
        walk(value, fullKey);
      }
    }
  }
  walk(parsed, '');
  return Array.from(keys).sort();
}

function countElements(input: string): { totalKeys: number; nestingLevel: number; arrayCount: number; objectCount: number; size: number } {
  const parsed = JSON.parse(input);
  let totalKeys = 0;
  let maxNesting = 0;
  let arrayCount = 0;
  let objectCount = 0;

  function walk(obj: unknown, depth: number) {
    maxNesting = Math.max(maxNesting, depth);
    if (Array.isArray(obj)) {
      arrayCount++;
      obj.forEach((item) => walk(item, depth + 1));
    } else if (obj && typeof obj === 'object') {
      objectCount++;
      const entries = Object.entries(obj);
      totalKeys += entries.length;
      for (const [, value] of entries) {
        walk(value, depth + 1);
      }
    }
  }
  walk(parsed, 0);

  return {
    totalKeys,
    nestingLevel: maxNesting,
    arrayCount,
    objectCount,
    size: new TextEncoder().encode(input).length,
  };
}

const definition: ToolDefinition = {
  id: 'json',
  name: 'JSON Utilities',
  description: 'Format, validate, minify, and analyze JSON data — extract keys, count elements, detect issues',
  version: '1.0.0',
  icon: '📋',
  params: [
    { name: 'action', type: 'string', description: 'Action: format, validate, minify, keys, analyze', required: true },
    { name: 'data', type: 'string', description: 'JSON data to process', required: true },
    { name: 'indent', type: 'number', description: 'Indentation size (for format, default 2)', required: false },
  ],
};

const execute: ToolExecutor = async (params, ctx) => {
  const action = String(params.action || 'format').toLowerCase();
  const rawData = String(params.data || params.query || ctx.userInput || '');
  const indent = typeof params.indent === 'number' ? params.indent : 2;

  // Try to extract JSON from the input (it might be wrapped in backticks or mixed with text)
  let jsonStr = rawData;
  const jsonMatch = rawData.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();

  // Also try finding a { } or [ ] block directly
  if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) {
    const braceMatch = rawData.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (braceMatch) jsonStr = braceMatch[1].trim();
  }

  if (!jsonStr.trim()) {
    return { success: false, output: 'Please provide JSON data to process.' };
  }

  switch (action) {
    case 'format':
    case 'prettify':
    case 'beautify': {
      try {
        const formatted = formatJSON(jsonStr, indent);
        return {
          success: true,
          output: `\`\`\`json\n${formatted}\n\`\`\``,
          data: { result: formatted },
        };
      } catch (e) {
        return { success: false, output: `Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}` };
      }
    }
    case 'minify':
    case 'compress': {
      try {
        const minified = minifyJSON(jsonStr);
        return {
          success: true,
          output: minified,
          data: { result: minified, originalSize: jsonStr.length, minifiedSize: minified.length },
        };
      } catch (e) {
        return { success: false, output: `Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}` };
      }
    }
    case 'validate':
    case 'check':
    case 'valid': {
      const result = validateJSON(jsonStr);
      if (result.valid) {
        return {
          success: true,
          output: `✅ Valid JSON (type: ${result.type})`,
          data: result,
        };
      }
      return {
        success: false,
        output: `❌ Invalid JSON: ${result.error}`,
        data: result,
      };
    }
    case 'keys':
    case 'schema':
    case 'structure': {
      try {
        const keys = extractKeys(jsonStr);
        const info = countElements(jsonStr);
        return {
          success: true,
          output: `📊 JSON Structure:\n• Keys (${keys.length}): ${keys.slice(0, 30).join(', ')}${keys.length > 30 ? '...' : ''}\n• Nesting depth: ${info.nestingLevel}\n• Objects: ${info.objectCount}, Arrays: ${info.arrayCount}\n• Raw size: ${info.size} bytes`,
          data: { keys, ...info },
        };
      } catch (e) {
        return { success: false, output: `Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}` };
      }
    }
    case 'analyze':
    case 'stats':
    case 'info': {
      try {
        const validation = validateJSON(jsonStr);
        if (!validation.valid) {
          return { success: false, output: `❌ Invalid JSON: ${validation.error}` };
        }
        const info = countElements(jsonStr);
        const keys = extractKeys(jsonStr);
        return {
          success: true,
          output: `📊 JSON Analysis:\n• Valid: ✅ (${validation.type})\n• Keys: ${info.totalKeys}\n• Nesting depth: ${info.nestingLevel}\n• Objects: ${info.objectCount}\n• Arrays: ${info.arrayCount}\n• Size: ${info.size} bytes${info.size > 1024 ? ` (${(info.size / 1024).toFixed(1)} KB)` : ''}`,
          data: { ...info, keys, valid: true },
        };
      } catch (e) {
        return { success: false, output: `Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}` };
      }
    }
    default:
      return {
        success: false,
        output: `Unknown action "${action}". Available: format, validate, minify, keys, analyze`,
      };
  }
};

function detect(input: string): { confidence: number; params: Record<string, unknown> } | null {
  const lower = input.toLowerCase();
  const hasJSON = input.includes('{') || input.includes('[');

  if (!hasJSON && !lower.includes('json')) return null;

  if (lower.includes('format') || lower.includes('prettify') || lower.includes('beautify')) {
    return { confidence: 0.8, params: { action: 'format', query: input } };
  }
  if (lower.includes('minify') || lower.includes('compress')) {
    return { confidence: 0.8, params: { action: 'minify', query: input } };
  }
  if (lower.includes('validate') || lower.includes('is valid') || lower.includes('check if')) {
    return { confidence: 0.8, params: { action: 'validate', query: input } };
  }
  if (lower.includes('keys') || lower.includes('structure') || lower.includes('schema')) {
    return { confidence: 0.7, params: { action: 'keys', query: input } };
  }
  if (lower.includes('analyze') || lower.includes('stats') || lower.includes('info about')) {
    return { confidence: 0.7, params: { action: 'analyze', query: input } };
  }

  return null;
}

export function registerJSONTool(): void {
  registerTool(definition, execute);
  console.log('[tools] JSON Utilities registered');
}
