import { describe, expect, test } from 'bun:test';
import { applySearchReplace, changedLineCount } from '../src/utils/edits';

describe('applySearchReplace', () => {
  test('replaces a unique snippet', () => {
    const content = 'const a = 1;\nconst b = 2;\n';
    const res = applySearchReplace(content, 'const b = 2;', 'const b = 3;');
    expect(res.ok).toBe(true);
    expect(res.newContent).toBe('const a = 1;\nconst b = 3;\n');
  });

  test('rejects ambiguous matches', () => {
    const content = 'x\ny\nx\n';
    const res = applySearchReplace(content, 'x', 'z');
    expect(res.ok).toBe(false);
    expect(res.matches).toBeGreaterThan(1);
  });

  test('rejects an empty oldString', () => {
    const res = applySearchReplace('abc', '', 'z');
    expect(res.ok).toBe(false);
  });

  test('returns a descriptive error when the snippet is not found', () => {
    const res = applySearchReplace('hello world', 'goodbye', 'hi');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Could not find');
  });

  test('deleting a whole line removes it cleanly', () => {
    const content = 'keep\nremove\nkeep2\n';
    const res = applySearchReplace(content, 'remove\n', '');
    expect(res.ok).toBe(true);
    expect(res.newContent).toBe('keep\nkeep2\n');
  });
});

describe('changedLineCount', () => {
  test('a one-line edit reports two changed lines (1 removed + 1 added)', () => {
    const { count } = changedLineCount('line1\nline2\nline3\n', 'line1\nCHANGED\nline3\n');
    expect(count).toBe(2);
  });

  test('no change reports zero', () => {
    const { count } = changedLineCount('a\nb\n', 'a\nb\n');
    expect(count).toBe(0);
  });

  test('a full rewrite reports many changed lines', () => {
    const { count } = changedLineCount('a\nb\nc\n', 'x\ny\nz\n');
    expect(count).toBeGreaterThanOrEqual(3);
  });
});
