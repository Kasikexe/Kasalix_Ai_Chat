/**
 * Random Generator Tool — random numbers, passwords, UUIDs, dice rolls, coin flips
 */

import { registerTool } from './index';
import type { ToolDefinition, ToolExecutor } from './index';
import crypto from 'crypto';

function generateUUID(): string {
  return crypto.randomUUID();
}

function generatePassword(length: number, useUppercase: boolean, useLowercase: boolean, useDigits: boolean, useSpecial: boolean): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const special = '!@#$%^&*()_+-=[]{}|;:,.<>?';
  let chars = '';
  if (useUppercase) chars += upper;
  if (useLowercase) chars += lower;
  if (useDigits) chars += digits;
  if (useSpecial) chars += special;
  if (!chars) chars = upper + lower + digits;

  let password = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    password += chars[bytes[i] % chars.length];
  }
  return password;
}

function rollDice(sides: number, count: number): { rolls: number[]; total: number; average: number } {
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    rolls.push(Math.floor(Math.random() * sides) + 1);
  }
  const total = rolls.reduce((a, b) => a + b, 0);
  const average = total / count;
  return { rolls, total, average: Math.round(average * 100) / 100 };
}

function flipCoin(count: number): { heads: number; tails: number; results: string[] } {
  const results: string[] = [];
  let heads = 0;
  for (let i = 0; i < count; i++) {
    if (Math.random() < 0.5) {
      results.push('heads');
      heads++;
    } else {
      results.push('tails');
    }
  }
  return { heads, tails: count - heads, results };
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number, decimals: number): number {
  const val = Math.random() * (max - min) + min;
  return parseFloat(val.toFixed(decimals));
}

function pickRandom(items: string): string {
  const list = items.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return '';
  return list[Math.floor(Math.random() * list.length)];
}

const definition: ToolDefinition = {
  id: 'random',
  name: 'Random Generator',
  description: 'Generate random numbers, passwords, UUIDs, dice rolls, coin flips, and random picks',
  version: '1.0.0',
  icon: '🎲',
  params: [
    { name: 'action', type: 'string', description: 'What to generate: number, password, uuid, dice, coin, pick, float', required: true },
    { name: 'min', type: 'number', description: 'Minimum value (for number/float)', required: false },
    { name: 'max', type: 'number', description: 'Maximum value (for number/float)', required: false },
    { name: 'length', type: 'number', description: 'Length (for password, default 16)', required: false },
    { name: 'sides', type: 'number', description: 'Dice sides (for dice, default 6)', required: false },
    { name: 'count', type: 'number', description: 'How many (for dice/coin, default 1)', required: false },
    { name: 'items', type: 'string', description: 'Comma-separated items to pick from', required: false },
  ],
};

const execute: ToolExecutor = async (params) => {
  const action = String(params.action || '').toLowerCase();
  const min = typeof params.min === 'number' ? params.min : 1;
  const max = typeof params.max === 'number' ? params.max : 100;
  const length = typeof params.length === 'number' ? params.length : 16;
  const sides = typeof params.sides === 'number' ? params.sides : 6;
  const count = typeof params.count === 'number' ? params.count : 1;

  switch (action) {
    case 'number':
    case 'int':
    case 'integer': {
      const val = randomInt(min, max);
      return { success: true, output: `${val}`, data: { value: val, min, max } };
    }
    case 'float':
    case 'decimal': {
      const decimals = typeof params.decimals === 'number' ? params.decimals : 2;
      const val = randomFloat(min, max, decimals);
      return { success: true, output: `${val}`, data: { value: val, min, max, decimals } };
    }
    case 'password':
    case 'pass':
    case 'pw': {
      const useUpper = params.uppercase !== false;
      const useLower = params.lowercase !== false;
      const useDigits = params.digits !== false;
      const useSpecial = params.special === true;
      const pw = generatePassword(length, useUpper, useLower, useDigits, useSpecial);
      return { success: true, output: `Generated password (${length} chars): \`${pw}\``, data: { password: pw, length } };
    }
    case 'uuid':
    case 'guid': {
      const uuid = generateUUID();
      return { success: true, output: `${uuid}`, data: { uuid } };
    }
    case 'dice':
    case 'dice roll':
    case 'roll': {
      const result = rollDice(sides, count);
      return {
        success: true,
        output: `Rolled ${count}d${sides}: [${result.rolls.join(', ')}] = ${result.total} (avg: ${result.average})`,
        data: result,
      };
    }
    case 'coin':
    case 'coin flip':
    case 'flip': {
      const result = flipCoin(count);
      const pct = count > 0 ? Math.round((result.heads / count) * 100) : 0;
      return {
        success: true,
        output: `Flipped ${count} coin(s): ${result.heads} heads, ${result.tails} tails (${pct}% heads)`,
        data: result,
      };
    }
    case 'pick':
    case 'choose': {
      const items = String(params.items || params.query || '');
      if (!items) {
        return { success: false, output: 'Please provide a comma-separated list of items to pick from.' };
      }
      const picked = pickRandom(items);
      return { success: true, output: `Picked: ${picked}`, data: { picked, from: items } };
    }
    default:
      return {
        success: false,
        output: `Unknown action "${action}". Available: number, float, password, uuid, dice, coin, pick`,
      };
  }
};

// Auto-detect random generator intent
function detect(input: string): { confidence: number; params: Record<string, unknown> } | null {
  const lower = input.toLowerCase();

  if (/roll\s+\d+d\d+|dice|d\d+\s*(?:roll|dice)/i.test(input)) {
    const m = input.match(/(\d+)\s*d\s*(\d+)/i);
    return {
      confidence: 0.9,
      params: { action: 'dice', count: m ? parseInt(m[1]) : 1, sides: m ? parseInt(m[2]) : 6 },
    };
  }

  if (/flip\s+(a\s+)?coin|coin\s+flip|toss/i.test(input)) {
    const m = input.match(/(\d+)/);
    return { confidence: 0.9, params: { action: 'coin', count: m ? parseInt(m[1]) : 1 } };
  }

  if (/generate\s+(a\s+)?password|random\s+password|create\s+(a\s+)?password/i.test(lower)) {
    const m = lower.match(/(\d+)\s*(char|character)/);
    return { confidence: 0.85, params: { action: 'password', length: m ? parseInt(m[1]) : 16 } };
  }

  if (/generate\s+(a\s+)?uuid|new\s+uuid|random\s+uuid/i.test(lower)) {
    return { confidence: 0.9, params: { action: 'uuid' } };
  }

  if (/random\s+number|random\s+int|pick\s+(a\s+)?random/i.test(lower)) {
    const m = lower.match(/(?:between|from|in)\s+(\d+)\s*(?:to|and|-)\s*(\d+)/);
    return {
      confidence: 0.7,
      params: { action: 'number', min: m ? parseInt(m[1]) : 1, max: m ? parseInt(m[2]) : 100 },
    };
  }

  if (/(?:pick|choose)\s+(?:a\s+)?random/i.test(lower) || /randomly\s+(?:pick|choose)/i.test(lower)) {
    return { confidence: 0.6, params: { action: 'pick', items: input.replace(/pick|choose|randomly|random/gi, '').replace(/from/gi, '').trim() } };
  }

  return null;
}

export function registerRandomTool(): void {
  registerTool(definition, execute);
  console.log('[tools] Random Generator registered');
}
