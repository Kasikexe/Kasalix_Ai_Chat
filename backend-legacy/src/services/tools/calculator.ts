/**
 * Calculator Tool — safely evaluates math expressions
 *
 * AI detects when the user asks to calculate something and runs it.
 * Uses a restricted math evaluator (no eval) for safety.
 */

import { registerTool } from './index';
import type { ToolDefinition, ToolExecutor } from './index';

// ─── Safe Math Evaluator ──────────────────────────────────
// A simple recursive-descent parser for arithmetic expressions.
// Supports: +, -, *, /, ^, %, parentheses, and common math functions.
// No arbitrary code execution — only math operations.

type Token =
  | { type: 'number'; value: number }
  | { type: 'op'; value: string }
  | { type: 'paren'; value: '(' | ')' }
  | { type: 'func'; value: string }
  | { type: 'comma'; value: ',' }
  | { type: 'ident'; value: string };

const MATH_FUNCS = new Set([
  'abs', 'floor', 'ceil', 'round', 'sqrt', 'cbrt',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'log', 'log2', 'log10', 'ln',
  'exp', 'pow', 'max', 'min',
  'pi', 'e',
]);

const MATH_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i++; continue; }

    // Number
    if (/\d/.test(ch)) {
      let num = '';
      while (i < expr.length && /[\d.]/.test(expr[i])) { num += expr[i]; i++; }
      tokens.push({ type: 'number', value: parseFloat(num) });
      continue;
    }

    // Function name or identifier (like pi, e)
    if (/[a-zA-Z_]/.test(ch)) {
      let name = '';
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) { name += expr[i]; i++; }
      if (name in MATH_CONSTANTS) {
        tokens.push({ type: 'number', value: MATH_CONSTANTS[name] });
      } else if (MATH_FUNCS.has(name)) {
        tokens.push({ type: 'func', value: name });
      } else {
        tokens.push({ type: 'ident', value: name });
      }
      continue;
    }

    // Operators
    if ('+-*/^%'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }

    // Parentheses
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i++;
      continue;
    }

    // Comma
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ',' });
      i++;
      continue;
    }

    // Unknown char — skip
    i++;
  }
  return tokens;
}

let pos = 0;
let tokens: Token[] = [];

function peek(): Token | null { return pos < tokens.length ? tokens[pos] : null; }
function consume(): Token | null { return pos < tokens.length ? tokens[pos++] : null; }

function parsePrimary(): number {
  const tok = peek();
  if (!tok) throw new Error('Unexpected end of expression');

  if (tok.type === 'number') {
    consume();
    return tok.value;
  }

  if (tok.type === 'paren' && tok.value === '(') {
    consume(); // eat '('
    const val = parseExpression();
    const close = consume();
    if (!close || close.type !== 'paren' || close.value !== ')') {
      throw new Error('Missing closing parenthesis');
    }
    return val;
  }

  if (tok.type === 'func') {
    consume();
    // Parse function arguments (inside parentheses)
    if (peek()?.type === 'paren' && peek()?.value === '(') {
      consume(); // eat '('
      const args: number[] = [];
      while (!(peek()?.type === 'paren' && peek()?.value === ')')) {
        args.push(parseExpression());
        if (peek()?.type === 'comma') consume();
      }
      consume(); // eat ')'
      return applyFunction(tok.value, args);
    }
    // No parentheses — might be a constant-like usage
    return applyFunction(tok.value, []);
  }

  if (tok.type === 'op' && tok.value === '-') {
    consume(); // unary minus
    return -parsePrimary();
  }
  if (tok.type === 'op' && tok.value === '+') {
    consume(); // unary plus
    return parsePrimary();
  }

  throw new Error(`Unexpected token: ${JSON.stringify(tok)}`);
}

function applyFunction(name: string, args: number[]): number {
  switch (name) {
    case 'abs': return Math.abs(args[0]);
    case 'floor': return Math.floor(args[0]);
    case 'ceil': return Math.ceil(args[0]);
    case 'round': return Math.round(args[0]);
    case 'sqrt': return Math.sqrt(args[0]);
    case 'cbrt': return Math.cbrt(args[0]);
    case 'sin': return Math.sin(args[0]);
    case 'cos': return Math.cos(args[0]);
    case 'tan': return Math.tan(args[0]);
    case 'asin': return Math.asin(args[0]);
    case 'acos': return Math.acos(args[0]);
    case 'atan': return Math.atan(args[0]);
    case 'log':
    case 'log10': return Math.log10(args[0]);
    case 'log2': return Math.log2(args[0]);
    case 'ln': return Math.log(args[0]);
    case 'exp': return Math.exp(args[0]);
    case 'pow': return Math.pow(args[0], args[1] || 1);
    case 'max': return Math.max(...args);
    case 'min': return Math.min(...args);
    default: throw new Error(`Unknown function: ${name}`);
  }
}

function parseExponent(): number {
  let left = parsePrimary();
  while (peek()?.type === 'op' && peek()?.value === '^') {
    consume();
    const right = parseExponent();
    left = Math.pow(left, right);
  }
  return left;
}

function parseMultiplicative(): number {
  let left = parseExponent();
  while (peek()?.type === 'op' && ('*/%'.includes(peek()?.value || ''))) {
    const op = consume()!.value;
    const right = parseExponent();
    if (op === '*') left *= right;
    else if (op === '/') {
      if (right === 0) throw new Error('Division by zero');
      left /= right;
    }
    else if (op === '%') {
      if (right === 0) throw new Error('Division by zero (modulo)');
      left %= right;
    }
  }
  return left;
}

function parseAdditive(): number {
  let left = parseMultiplicative();
  while (peek()?.type === 'op' && (peek()?.value === '+' || peek()?.value === '-')) {
    const op = consume()!.value;
    const right = parseMultiplicative();
    if (op === '+') left += right;
    else left -= right;
  }
  return left;
}

function parseExpression(): number {
  return parseAdditive();
}

function safeEval(expr: string): number {
  tokens = tokenize(expr);
  pos = 0;
  const result = parseExpression();
  if (peek() !== null) {
    throw new Error(`Unexpected tokens after expression`);
  }
  return result;
}

// ─── Tool Definition ──────────────────────────────────────

const definition: ToolDefinition = {
  id: 'calculator',
  name: 'Calculator',
  description: 'Evaluate math expressions: arithmetic, trigonometry, logarithms, powers, and more',
  version: '1.0.0',
  icon: '🧮',
  params: [
    { name: 'expression', type: 'string', description: 'Math expression to evaluate (e.g., "2 + 2", "sqrt(144)", "sin(45)")', required: true },
  ],
};

const execute: ToolExecutor = async (params) => {
  const expr = String(params.expression || params.query || '');
  if (!expr.trim()) {
    return { success: false, output: 'Please provide a math expression to evaluate.' };
  }

  try {
    const result = safeEval(expr);
    const formatted = Number.isInteger(result) ? result.toString() : result.toFixed(4);
    return {
      success: true,
      output: `${expr} = ${formatted}`,
      data: { expression: expr, result },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      output: `Could not evaluate "${expr}": ${msg}`,
    };
  }
};

// Auto-detect calculator intent from user input
const CALC_PATTERNS = [
  /(\d+)\s*([+\-*/^])\s*(\d+)/,
  /calculate\s+(.+)/i,
  /what (is|'s)\s+(.+)/,
  /compute\s+(.+)/i,
  /solve\s+(.+)/i,
];

function detect(input: string): { confidence: number; params: Record<string, unknown> } | null {
  const lower = input.toLowerCase();

  // Skip if it's clearly a conversion
  if (lower.includes('convert') || lower.includes('cm') || lower.includes('inches') || lower.includes('feet')) {
    return null;
  }

  // Contains clear math operators
  if (/[\d]\s*[+\-*/^%]\s*[\d]/.test(input) && !lower.includes('http')) {
    return { confidence: 0.8, params: { expression: input.trim() } };
  }

  // Starts with "calculate", "what is", "compute", "solve"
  for (const pat of CALC_PATTERNS) {
    const m = input.match(pat);
    if (m) {
      const expr = m[m.length - 1].trim();
      if (expr.length > 0 && expr.length < 200) {
        return { confidence: 0.7, params: { expression: expr } };
      }
    }
  }

  return null;
}

// ─── Register ─────────────────────────────────────────────

export function registerCalculatorTool(): void {
  registerTool(definition, execute);
  console.log('[tools] Calculator registered with safe math evaluator');
}
