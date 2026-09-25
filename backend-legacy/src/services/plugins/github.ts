/**
 * Plugin Platform — GitHub fetcher
 *
 * Downloads a plugin from a GitHub repository using the public API:
 *   1. Resolve the default branch
 *   2. Fetch the recursive file tree
 *   3. Download each file's content (raw.githubusercontent.com)
 * This needs no auth token and works for public repos.
 */

import { logger as appLogger } from '../logger';

const GITHUB_API = 'https://api.github.com';
const RAW_BASE = 'https://raw.githubusercontent.com';
const USER_AGENT = 'Kasalix-Server/1.0';

export interface RepoSpec {
  owner: string;
  repo: string;
  /** Optional subdirectory inside the repo that holds the plugin */
  path?: string;
  branch: string;
}

/** Normalize "owner/repo", "owner/repo/subdir", or a full GitHub URL. */
export function parseRepoInput(input: string): { owner: string; repo: string; path?: string } {
  let s = input.trim();
  if (!s) throw new Error('Repository is required');
  // Full URL form: https://github.com/owner/repo/tree/branch/subdir or /owner/repo
  const urlMatch = s.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/(?:tree|blob)\/[^/\s]+)?(?:\/([^#?\s]*))?/i);
  let parts: string[];
  if (urlMatch) {
    parts = [urlMatch[1], urlMatch[2], ...(urlMatch[3] ? urlMatch[3].split('/').filter(Boolean) : [])];
  } else {
    parts = s.split('/').filter(Boolean);
  }
  if (parts.length < 2) {
    throw new Error('Invalid repository. Use "owner/repo" or a GitHub URL.');
  }
  const owner = parts[0].replace(/[^\w.-]/g, '');
  const repo = parts[1].replace(/[^\w.-]/g, '');
  if (!owner || !repo) throw new Error('Invalid repository name');
  const path = parts.length > 2 ? parts.slice(2).join('/') : undefined;
  return { owner, repo, path: path || undefined };
}

async function githubJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub API rate limit reached. Try again in a few minutes.');
  }
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status} for ${url}`);
  }
  return res.json();
}

/** Resolve the repo's default branch and validate it exists. */
export async function resolveRepo(spec: { owner: string; repo: string }): Promise<string> {
  const info = await githubJson(`${GITHUB_API}/repos/${spec.owner}/${spec.repo}`);
  const branch = info?.default_branch || 'main';
  if (typeof branch !== 'string' || !branch) {
    throw new Error('Could not determine the repository default branch');
  }
  return branch;
}

/** Get every file path in the repo (optionally under a subdirectory). */
export async function getRepoFiles(
  owner: string,
  repo: string,
  branch: string,
  subdir?: string
): Promise<string[]> {
  const tree = await githubJson(
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  );
  const entries: { path?: string; type?: string }[] = tree?.tree || [];
  const prefix = subdir ? subdir.replace(/^\/+|\/+$/g, '') + '/' : '';
  return entries
    .filter((e) => e.type === 'blob' && e.path)
    .map((e) => e.path as string)
    .filter((p) => {
      if (prefix && !p.startsWith(prefix)) return false;
      const rel = prefix ? p.slice(prefix.length) : p;
      // Skip VCS metadata and build junk
      if (rel.startsWith('.git/') || rel.startsWith('node_modules/') || rel === '.git') return false;
      if (rel.includes('/node_modules/')) return false;
      return true;
    });
}

/** Download a single file's text content. Returns null if not found. */
export async function downloadRawFile(
  owner: string,
  repo: string,
  branch: string,
  pathInRepo: string
): Promise<string | null> {
  const url = `${RAW_BASE}/${owner}/${repo}/${encodeURIComponent(branch)}/${pathInRepo
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to download ${pathInRepo} (HTTP ${res.status})`);
  const text = await res.text();
  if (text.length > 5 * 1024 * 1024) {
    throw new Error(`File too large: ${pathInRepo} (over 5 MB)`);
  }
  return text;
}

/** Download the repo metadata we need in one call (used by the install flow). */
export async function fetchRepoTree(spec: RepoSpec): Promise<string[]> {
  return getRepoFiles(spec.owner, spec.repo, spec.branch, spec.path);
}

export { appLogger };
