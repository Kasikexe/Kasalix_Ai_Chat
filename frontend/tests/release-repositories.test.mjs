import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const configPath = fileURLToPath(new URL('../src/config.ts', import.meta.url));

async function loadConfig(env) {
  const result = await build({
    entryPoints: [configPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    define: { 'import.meta.env': JSON.stringify(env) },
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

test('releases and feedback use their intended repositories', async () => {
  const config = await loadConfig({});
  assert.equal(config.GITHUB_RELEASES_API, 'https://api.github.com/repos/Kasikexe/Kasalix_Ai_Chat/releases');
  assert.equal(config.RELEASES_URL, 'https://github.com/Kasikexe/Kasalix_Ai_Chat/releases');
  assert.equal(config.NEW_ISSUE_URL, 'https://github.com/Kasikexe/Kasalix/issues/new');
  assert.equal(config.IDEAS_URL, 'https://github.com/Kasikexe/Kasalix/discussions/categories/ideas');
});

test('forks can use separate repositories or retain the existing shared override', async () => {
  const shared = await loadConfig({ VITE_GITHUB_REPO: 'fork/shared' });
  assert.equal(shared.RELEASES_URL, 'https://github.com/fork/shared/releases');
  const separate = await loadConfig({ VITE_GITHUB_REPO: 'fork/feedback', VITE_GITHUB_RELEASE_REPO: 'fork/releases' });
  assert.equal(separate.NEW_ISSUE_URL, 'https://github.com/fork/feedback/issues/new');
  assert.equal(separate.RELEASES_URL, 'https://github.com/fork/releases/releases');
});
