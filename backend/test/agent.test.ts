import { describe, expect, test, afterAll } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  extractToolCall,
  parseCodeBlockFiles,
  pruneToBudget,
  estimateTokens,
  isTransientError,
  detectVerifyCommand,
} from '../src/services/agent';

describe('extractToolCall', () => {
  test('parses a clean JSON tool call', () => {
    const call = extractToolCall('{"tool": "read_file", "args": {"path": "src/index.ts"}}');
    expect(call).toEqual({ tool: 'read_file', args: { path: 'src/index.ts' } });
  });

  test('tolerates markdown fences', () => {
    const raw = '```json\n{"tool": "list_files", "args": {}}\n```';
    expect(extractToolCall(raw)?.tool).toBe('list_files');
  });

  test('extracts from surrounding prose', () => {
    const raw = 'Let me check that. {"tool": "search_files", "args": {"query": "foo"}} Done.';
    expect(extractToolCall(raw)?.tool).toBe('search_files');
  });

  test('rejects unknown tools', () => {
    expect(extractToolCall('{"tool": "rm_rf", "args": {}}')).toBeNull();
  });

  test('returns null for plain prose', () => {
    expect(extractToolCall('Hello, how can I help?')).toBeNull();
  });

  test('returns null for malformed JSON', () => {
    expect(extractToolCall('{"tool": "read_file", "args": {"path": "unterminated')).toBeNull();
  });
});

describe('parseCodeBlockFiles', () => {
  test('parses a new-file block with a path comment', () => {
    const blocks = parseCodeBlockFiles('Here is the file:\n\n```python\n# main.py\nprint("hi")\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('create');
    expect(blocks[0].path).toBe('main.py');
    expect(blocks[0].content).toContain('print("hi")');
  });

  test('parses an EDIT block (OLD:/NEW: on their own lines)', () => {
    const raw = '```\n// EDIT: src/app.ts\nOLD:\nconst x = 1;\n---\nNEW:\nconst x = 2;\n```';
    const blocks = parseCodeBlockFiles(raw);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('edit');
    expect(blocks[0].path).toBe('src/app.ts');
    expect(blocks[0].oldString).toBe('const x = 1;');
    expect(blocks[0].newString).toBe('const x = 2;');
  });

  test('parses a DELETE block', () => {
    const blocks = parseCodeBlockFiles('```\n// DELETE: src/old.ts\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('delete');
    expect(blocks[0].path).toBe('src/old.ts');
  });
});

describe('context budget', () => {
  test('estimateTokens is roughly chars/4', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('')).toBe(0);
  });

  test('small history is left alone', () => {
    const msgs = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ];
    expect(pruneToBudget(msgs)).toEqual(msgs);
  });

  test('oversized history prunes oldest non-system messages, keeps the newest', () => {
    const big = 'x'.repeat(20000); // ~5000 tokens each
    const msgs = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, content: `msg${i}:${big}` })),
    ];
    const pruned = pruneToBudget(msgs);
    expect(pruned[0].role).toBe('system');
    const nonSystem = pruned.filter((m) => m.role !== 'system');
    expect(nonSystem.length).toBeGreaterThanOrEqual(6);
    expect(nonSystem.length).toBeLessThan(20);
    expect(nonSystem[nonSystem.length - 1].content).toBe(`msg19:${big}`);
  });
});

describe('isTransientError', () => {
  test('network failures are transient', () => {
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
    expect(isTransientError(new Error('ECONNREFUSED 127.0.0.1:11434'))).toBe(true);
  });

  test('5xx is transient', () => {
    expect(isTransientError(new Error('Ollama error (503): unavailable'))).toBe(true);
  });

  test('aborts are never retried', () => {
    expect(isTransientError(new DOMException('Aborted', 'AbortError'))).toBe(false);
  });

  test('4xx (e.g. model missing) is never retried', () => {
    expect(isTransientError(new Error('Ollama error (404): model not found'))).toBe(false);
  });
});

describe('detectVerifyCommand', () => {
  const dirs: string[] = [];

  async function fixture(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kasalix-agent-'));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    return dir;
  }

  test('detects npm test from package.json', async () => {
    const dir = await fixture({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });
    const cmd = await detectVerifyCommand(dir);
    expect(cmd?.label).toBe('npm test');
  });

  test('custom .agent-config.json wins over package.json', async () => {
    const dir = await fixture({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      '.agent-config.json': JSON.stringify({ verifyCommand: 'npm run lint', verifyLabel: 'lint' }),
    });
    const cmd = await detectVerifyCommand(dir);
    expect(cmd?.command).toContain('npm run lint');
    expect(cmd?.label).toBe('lint');
  });

  test('verifyEnabled:false disables auto-verify entirely', async () => {
    const dir = await fixture({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      '.agent-config.json': JSON.stringify({ verifyEnabled: false }),
    });
    expect(await detectVerifyCommand(dir)).toBeNull();
  });

  test('returns null for a directory with no recognizable project', async () => {
    const dir = await fixture({ 'readme.txt': 'nothing here' });
    expect(await detectVerifyCommand(dir)).toBeNull();
  });

  afterAll(async () => {
    for (const d of dirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });
});
