// Shared service for fetching release notes from the GitHub Releases API.
// Used by the Changelog view and the update notification banner.

import { GITHUB_RELEASES_API, RELEASES_URL } from '../config';

export const GITHUB_RELEASES_PAGE = RELEASES_URL;
// Cache releases briefly so the GitHub API (rate-limited) isn't hit repeatedly
const CACHE_KEY = 'kasalix:changelog:releases';
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export interface ChangelogEntry {
  version: string;
  title: string;
  description: string;
  date: string;
  type: 'major' | 'minor' | 'patch';
  prerelease: boolean;
  url: string;
}

/** A release as returned by the GitHub Releases API */
interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
  html_url: string;
}

/** Guess the change type from a semver-ish tag (v1.2.3 → major/minor/patch). */
function deriveType(tag: string): ChangelogEntry['type'] {
  const clean = tag.replace(/^v/i, '').split('-')[0];
  const parts = clean.split('.').map(Number);
  if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
    if (parts[1] === 0 && parts[2] === 0) return 'major';
    if (parts[2] === 0) return 'minor';
    return 'patch';
  }
  return 'minor';
}

function toEntry(release: GitHubRelease): ChangelogEntry {
  return {
    version: release.tag_name.replace(/^v/i, ''),
    title: release.name || release.tag_name,
    description: release.body?.trim() || '_No description provided._',
    date: release.published_at,
    type: deriveType(release.tag_name),
    prerelease: !!release.prerelease,
    url: release.html_url,
  };
}

function loadCache(ignoreTTL = false): ChangelogEntry[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.entries)) return null;
    if (!ignoreTTL && Date.now() - (parsed.fetchedAt || 0) > CACHE_TTL) return null;
    return parsed.entries as ChangelogEntry[];
  } catch {
    return null;
  }
}

function saveCache(entries: ChangelogEntry[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), entries }));
  } catch {
    /* storage may be unavailable — ignore */
  }
}

/** Fresh cached releases, or null when the cache is missing/expired. */
export function getCachedReleases(): ChangelogEntry[] | null {
  return loadCache();
}

/** Cached releases ignoring freshness (for offline fallback), or null. */
export function getStaleReleases(): ChangelogEntry[] | null {
  return loadCache(true);
}

/**
 * Fetch releases from GitHub and update the cache.
 * Throws on network errors; 403/429 (rate limit) throws Error('rate-limited').
 */
export async function fetchReleases(): Promise<ChangelogEntry[]> {
  const res = await fetch(GITHUB_RELEASES_API);
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) throw new Error('rate-limited');
    throw new Error(`HTTP ${res.status}`);
  }
  const data: GitHubRelease[] = await res.json();
  if (!Array.isArray(data)) throw new Error('Unexpected response from GitHub');
  const list = data
    .filter((r) => !r.draft)
    .map(toEntry)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  saveCache(list);
  return list;
}

/**
 * Get the release entry for a specific version (e.g. "0.9.0" or "v0.9.0").
 * Checks the cache first, then the network, then the stale cache.
 * Returns null when nothing matches or fetching fails.
 */
export async function getReleaseForVersion(version: string): Promise<ChangelogEntry | null> {
  const clean = version.replace(/^v/i, '');
  const find = (list: ChangelogEntry[] | null) => list?.find((e) => e.version === clean) || null;
  const fromCache = find(getCachedReleases());
  if (fromCache) return fromCache;
  try {
    return find(await fetchReleases());
  } catch {
    return find(getStaleReleases());
  }
}

export { openExternal } from '../utils/openExternal';
