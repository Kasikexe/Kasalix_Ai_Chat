/**
 * Text Utilities Tool — word/character counting, case conversion, encoding, etc.
 *
 * AI detects when the user wants text analysis or transformation.
 */

import { registerTool } from './index';
import type { ToolDefinition, ToolExecutor } from './index';

// ─── Helper functions ─────────────────────────────────────

function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

function charCount(text: string): number {
  return text.length;
}

function charCountNoSpaces(text: string): number {
  return text.replace(/\s/g, '').length;
}

function lineCount(text: string): number {
  return text.split('\n').length;
}

function sentenceCount(text: string): number {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  return sentences.length;
}

function reverseString(text: string): string {
  return text.split('').reverse().join('');
}

function toUpperCase(text: string): string {
  return text.toUpperCase();
}

function toLowerCase(text: string): string {
  return text.toLowerCase();
}

function toTitleCase(text: string): string {
  return text.replace(/\w\S*/g, (word) => {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

function toCamelCase(text: string): string {
  return text
    .replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase())
    .replace(/[-_\s]/g, '');
}

function toSnakeCase(text: string): string {
  return text
    .replace(/([A-Z])/g, '_$1')
    .replace(/[-_\s]+/g, '_')
    .toLowerCase()
    .replace(/^_/, '');
}

function base64Encode(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

function base64Decode(text: string): string {
  return Buffer.from(text, 'base64').toString('utf-8');
}

function urlEncode(text: string): string {
  return encodeURIComponent(text);
}

function urlDecode(text: string): string {
  return decodeURIComponent(text);
}

function countVowels(text: string): number {
  return (text.match(/[aeiouáéíóúàèìòùäëïöüâêîôû]/gi) || []).length;
}

function countConsonants(text: string): number {
  return (text.match(/[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ]/g) || []).length;
}

const OPERATIONS: Record<string, (text: string) => string> = {
  'uppercase': toUpperCase,
  'lowercase': toLowerCase,
  'titlecase': toTitleCase,
  'camelcase': toCamelCase,
  'snakecase': toSnakeCase,
  'reverse': reverseString,
  'base64encode': base64Encode,
  'base64decode': base64Decode,
  'urlencode': urlEncode,
  'urldecode': urlDecode,
};

function detectOperation(input: string): string | null {
  const lower = input.toLowerCase();
  if (lower.includes('uppercase') || lower.includes('upper case') || lower.includes('capitalize') || lower.includes('all caps')) return 'uppercase';
  if (lower.includes('lowercase') || lower.includes('lower case')) return 'lowercase';
  if (lower.includes('title case') || lower.includes('titlecase')) return 'titlecase';
  if (lower.includes('camel case') || lower.includes('camelcase')) return 'camelcase';
  if (lower.includes('snake case') || lower.includes('snakecase')) return 'snakecase';
  if (lower.includes('reverse') || lower.includes('backwards')) return 'reverse';
  if (lower.includes('base64 encode') || lower.includes('base64 encode')) return 'base64encode';
  if (lower.includes('base64 decode') || lower.includes('decode base64')) return 'base64decode';
  if (lower.includes('url encode')) return 'urlencode';
  if (lower.includes('url decode')) return 'urldecode';
  return null;
}

// ─── Tool Definition ──────────────────────────────────────

const definition: ToolDefinition = {
  id: 'text',
  name: 'Text Utilities',
  description: 'Analyze and transform text: word/char/line/sentence count, case conversion, encoding (base64, URL), and more',
  version: '1.0.0',
  icon: '📝',
  params: [
    { name: 'operation', type: 'string', description: 'What to do: count, uppercase, lowercase, titlecase, camelcase, snakecase, reverse, base64encode, base64decode, urlencode, urldecode', required: true },
    { name: 'text', type: 'string', description: 'The text to analyze or transform', required: true },
  ],
};

const execute: ToolExecutor = async (params, ctx) => {
  const text = String(params.text || params.query || ctx.userInput || '');
  const operation = String(params.operation || detectOperation(ctx.userInput) || 'count').toLowerCase();

  if (!text.trim()) {
    return { success: false, output: 'Please provide some text to analyze or transform.' };
  }

  // Analysis operations
  if (operation === 'count' || operation === 'stats' || operation === 'analyze') {
    const wc = wordCount(text);
    const cc = charCount(text);
    const ccns = charCountNoSpaces(text);
    const lc = lineCount(text);
    const sc = sentenceCount(text);
    const vowels = countVowels(text);
    const consonants = countConsonants(text);

    return {
      success: true,
      output: `📊 Text Statistics:\n• Words: ${wc}\n• Characters: ${cc} (${ccns} without spaces)\n• Lines: ${lc}\n• Sentences: ${sc}\n• Vowels: ${vowels}\n• Consonants: ${consonants}`,
      data: { words: wc, chars: cc, charsNoSpaces: ccns, lines: lc, sentences: sc, vowels, consonants },
    };
  }

  // Transformation operations
  const transformer = OPERATIONS[operation];
  if (transformer) {
    try {
      const result = transformer(text);
      return {
        success: true,
        output: result,
        data: { operation, input: text, output: result },
      };
    } catch (e) {
      return {
        success: false,
        output: `Failed to ${operation}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return {
    success: false,
    output: `Unknown operation "${operation}". Available: count/stats, uppercase, lowercase, titlecase, camelcase, snakecase, reverse, base64encode, base64decode, urlencode, urldecode`,
  };
};

// Auto-detect text utility intent
function detect(input: string): { confidence: number; params: Record<string, unknown> } | null {
  const lower = input.toLowerCase();

  const isAnalysis =
    lower.includes('word count') || lower.includes('character count') ||
    lower.includes('how many words') || lower.includes('how many characters') ||
    lower.includes('count words') || lower.includes('count characters') ||
    lower.includes('text stats') || lower.includes('analyze this text');

  const isTransform =
    lower.includes('uppercase') || lower.includes('lowercase') ||
    lower.includes('title case') || lower.includes('camel case') ||
    lower.includes('snake case') || lower.includes('reverse') ||
    lower.includes('base64') || lower.includes('url encode') ||
    lower.includes('url decode');

  if (isAnalysis || isTransform) {
    return { confidence: 0.7, params: { operation: isAnalysis ? 'count' : detectOperation(input) || 'count', query: input } };
  }

  return null;
}

// ─── Register ─────────────────────────────────────────────

export function registerTextTool(): void {
  registerTool(definition, execute);
  console.log('[tools] Text Utilities registered');
}

export { detectOperation, wordCount, charCount, lineCount };
