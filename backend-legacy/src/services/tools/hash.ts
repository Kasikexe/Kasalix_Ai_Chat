/**
 * Hash Tool — generate cryptographic hashes (MD5, SHA1, SHA256, SHA512, HMAC)
 */

import { registerTool } from './index';
import type { ToolDefinition, ToolExecutor } from './index';
import crypto from 'crypto';

const HASH_ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha384', 'sha512', 'sha3-256', 'sha3-512', 'blake2b512', 'blake2s256'];

function generateHash(text: string, algorithm: string): string {
  return crypto.createHash(algorithm).update(text, 'utf-8').digest('hex');
}

function generateHMAC(text: string, key: string, algorithm: string): string {
  return crypto.createHmac(algorithm, key).update(text, 'utf-8').digest('hex');
}

function hashFile(text: string): { md5: string; sha1: string; sha256: string; sha512: string } {
  return {
    md5: generateHash(text, 'md5'),
    sha1: generateHash(text, 'sha1'),
    sha256: generateHash(text, 'sha256'),
    sha512: generateHash(text, 'sha512'),
  };
}

const definition: ToolDefinition = {
  id: 'hash',
  name: 'Hash Generator',
  description: 'Generate cryptographic hashes: MD5, SHA1, SHA256, SHA512, SHA3, HMAC. Also verify hashes.',
  version: '1.0.0',
  icon: '🔒',
  params: [
    { name: 'action', type: 'string', description: 'Action: hash, hmac, all, verify', required: true },
    { name: 'text', type: 'string', description: 'Text to hash', required: true },
    { name: 'algorithm', type: 'string', description: 'Hash algorithm: md5, sha1, sha256, sha512, sha3-256, blake2b (default: sha256)', required: false },
    { name: 'key', type: 'string', description: 'Secret key (for HMAC)', required: false },
    { name: 'hash', type: 'string', description: 'Expected hash (for verification)', required: false },
  ],
};

const execute: ToolExecutor = async (params, ctx) => {
  const text = String(params.text || params.query || ctx.userInput || '');
  const action = String(params.action || 'hash').toLowerCase();
  const algorithm = String(params.algorithm || 'sha256').toLowerCase();
  const key = String(params.key || '');
  const expectedHash = String(params.hash || '').toLowerCase();

  if (!text.trim()) {
    return { success: false, output: 'Please provide text to hash.' };
  }

  switch (action) {
    case 'hash':
    case 'generate':
    case 'digest': {
      if (!HASH_ALGORITHMS.includes(algorithm)) {
        return {
          success: false,
          output: `Unsupported algorithm "${algorithm}". Available: ${HASH_ALGORITHMS.join(', ')}`,
        };
      }
      const hash = generateHash(text, algorithm);
      return {
        success: true,
        output: `${algorithm.toUpperCase()}: ${hash}`,
        data: { algorithm, hash, input: text },
      };
    }

    case 'hmac':
    case 'mac': {
      if (!key) {
        return { success: false, output: 'An HMAC key is required for HMAC generation.' };
      }
      if (!HASH_ALGORITHMS.includes(algorithm)) {
        return {
          success: false,
          output: `Unsupported algorithm "${algorithm}". Available: ${HASH_ALGORITHMS.join(', ')}`,
        };
      }
      const hmac = generateHMAC(text, key, algorithm);
      return {
        success: true,
        output: `HMAC-${algorithm.toUpperCase()}: ${hmac}`,
        data: { algorithm: `hmac-${algorithm}`, hash: hmac },
      };
    }

    case 'all':
    case 'full': {
      const results = hashFile(text);
      return {
        success: true,
        output: `All hashes for "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}":\n• MD5:    ${results.md5}\n• SHA1:   ${results.sha1}\n• SHA256: ${results.sha256}\n• SHA512: ${results.sha512}`,
        data: results,
      };
    }

    case 'verify':
    case 'check':
    case 'compare': {
      if (!expectedHash) {
        return { success: false, output: 'Please provide a hash to verify against.' };
      }
      const computed = generateHash(text, algorithm);
      const match = computed === expectedHash;
      return {
        success: true,
        output: match
          ? `✅ Hash matches! ${algorithm.toUpperCase()}: ${computed}`
          : `❌ Hash does NOT match.\nExpected: ${expectedHash}\nComputed: ${computed}`,
        data: { match, expected: expectedHash, computed, algorithm },
      };
    }

    default:
      return {
        success: false,
        output: `Unknown action "${action}". Available: hash, hmac, all, verify`,
      };
  }
};

function detect(input: string): { confidence: number; params: Record<string, unknown> } | null {
  const lower = input.toLowerCase();

  const hashKeywords = ['md5', 'sha1', 'sha256', 'sha512', 'sha3', 'blake2', 'hash', 'hmac'];

  const hasKeyword = hashKeywords.some((kw) => lower.includes(kw));
  const wantsHash = /generate\s+(a\s+)?hash|create\s+(a\s+)?hash|hash\s+(this|the|of)|compute\s+(a\s+)?hash/i.test(lower);
  const wantsVerify = /(verify|check|compare)\s+(a\s+)?hash|hash\s+(match|verify|check)|does.*match/i.test(lower);

  if (wantsHash) return { confidence: 0.8, params: { action: 'all', query: input } };
  if (wantsVerify) return { confidence: 0.7, params: { action: 'verify', query: input } };
  if (hasKeyword && (lower.includes('hash') || lower.includes('generate') || lower.includes('compute') || lower.includes('create'))) {
    return { confidence: 0.6, params: { action: 'all', query: input } };
  }

  return null;
}

export function registerHashTool(): void {
  registerTool(definition, execute);
  console.log('[tools] Hash Generator registered');
}
