import { promises as fs } from 'fs';
import path from 'path';
import { getDataDir } from '../utils/helpers';

const DATA_DIR = path.join(getDataDir(), 'changelog');

export interface ChangelogEntry {
  version: string;
  title: string;
  description: string;
  date: string; // ISO date string
  type: 'major' | 'minor' | 'patch';
}

export interface ChangelogDraft {
  description: string;
  autoSavedAt: number;
}

const FILE_PATH = path.join(DATA_DIR, 'changelog.json');
const DRAFT_PATH = path.join(DATA_DIR, 'draft.json');

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function getAll(): Promise<ChangelogEntry[]> {
  try {
    const data = await fs.readFile(FILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveAll(entries: ChangelogEntry[]): Promise<void> {
  await ensureDir();
  await fs.writeFile(FILE_PATH, JSON.stringify(entries, null, 2), 'utf-8');
}

export async function getChangelog(): Promise<ChangelogEntry[]> {
  const entries = await getAll();
  // Sort by version descending (newest first)
  entries.sort((a, b) => compareVersions(b.version, a.version));
  return entries;
}

export async function addChangelogEntry(entry: Omit<ChangelogEntry, 'date'> & { date?: string }): Promise<ChangelogEntry> {
  const entries = await getAll();
  const newEntry: ChangelogEntry = {
    ...entry,
    date: entry.date || new Date().toISOString().split('T')[0],
  };
  // Remove existing entry for same version if it exists
  const filtered = entries.filter((e) => e.version !== entry.version);
  filtered.push(newEntry);
  await saveAll(filtered);
  return newEntry;
}

export async function deleteChangelogEntry(version: string): Promise<boolean> {
  const entries = await getAll();
  const filtered = entries.filter((e) => e.version !== version);
  if (filtered.length === entries.length) return false;
  await saveAll(filtered);
  return true;
}

// ─── Draft Support ───────────────────────────────────────────

const DEFAULT_DRAFT: ChangelogDraft = { description: '', autoSavedAt: 0 };

async function getDraftRaw(): Promise<ChangelogDraft> {
  try {
    const data = await fs.readFile(DRAFT_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { ...DEFAULT_DRAFT };
  }
}

async function saveDraftRaw(draft: ChangelogDraft): Promise<void> {
  await ensureDir();
  await fs.writeFile(DRAFT_PATH, JSON.stringify(draft, null, 2), 'utf-8');
}

export async function getDraft(): Promise<ChangelogDraft> {
  return getDraftRaw();
}

export async function updateDraft(description: string): Promise<ChangelogDraft> {
  const draft: ChangelogDraft = {
    description,
    autoSavedAt: Date.now(),
  };
  await saveDraftRaw(draft);
  return draft;
}

export async function publishDraft(
  version: string,
  title: string,
  type: 'major' | 'minor' | 'patch'
): Promise<ChangelogEntry> {
  const draft = await getDraftRaw();
  const entry = await addChangelogEntry({
    version,
    title,
    description: draft.description || '(no changes listed)',
    type,
  });
  // Clear the draft after publishing
  await saveDraftRaw({ ...DEFAULT_DRAFT });
  return entry;
}

/** Simple version comparison (semver-like) */
function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aNum = aParts[i] || 0;
    const bNum = bParts[i] || 0;
    if (aNum !== bNum) return aNum - bNum;
  }
  return 0;
}
