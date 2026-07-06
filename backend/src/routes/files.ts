import { Hono } from 'hono';
import { promises as fs } from 'fs';
import path from 'path';
import type { Variables } from '../types';

const files = new Hono<{ Variables: Variables }>();

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.DS_Store',
  '__pycache__', '.next', '.nuxt', 'dist', 'build', '.cache',
  'target', 'vendor', '.venv', 'venv', 'env',
]);

const MAX_FILE_SIZE = 1024 * 1024; // 1MB max for preview

// Detect language from file extension
function detectLanguage(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
    '.json': 'json', '.md': 'markdown', '.css': 'css', '.scss': 'scss',
    '.html': 'html', '.xml': 'xml', '.svg': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
    '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.c': 'c', '.cpp': 'cpp',
    '.h': 'c', '.hpp': 'cpp', '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
    '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.ps1': 'powershell',
    '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql',
    '.dockerfile': 'dockerfile', '.txt': 'text', '.env': 'text',
    '.toml': 'ini', '.ini': 'ini', '.cfg': 'ini',
    '.vue': 'vue', '.svelte': 'html', '.astro': 'html',
  };
  return map[ext] || null;
}

// Check if content appears to be binary
function isBinaryContent(buffer: Buffer): boolean {
  const sampleSize = Math.min(buffer.length, 8192);
  for (let i = 0; i < sampleSize; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

files.get('/', async (c) => {
  const dirPath = c.req.query('path');
  if (!dirPath) {
    return c.json({ error: 'path query parameter is required' }, 400);
  }

  // Security: resolve the path and ensure it's absolute
  const resolved = path.resolve(dirPath);

  try {
    await fs.access(resolved);
  } catch {
    return c.json({ error: 'Directory does not exist' }, 404);
  }

  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    return c.json({ error: 'Path is not a directory' }, 400);
  }

  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true });

    const result = await Promise.all(
      entries
        .filter((entry) => !entry.name.startsWith('.') && !IGNORE_DIRS.has(entry.name))
        .map(async (entry) => {
          const fullPath = path.join(resolved, entry.name);
          let size: number | undefined;
          if (entry.isFile()) {
            try {
              const fileStat = await fs.stat(fullPath);
              size = fileStat.size;
            } catch { /* skip */ }
          }
          return {
            name: entry.name,
            path: fullPath,
            type: entry.isDirectory() ? 'directory' : 'file',
            size,
          };
        })
    );

    // Sort: directories first, then files, alphabetically
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return c.json({ entries: result });
  } catch (e) {
    return c.json({ error: 'Failed to read directory' }, 500);
  }
});

files.get('/content', async (c) => {
  const filePath = c.req.query('path');
  if (!filePath) {
    return c.json({ error: 'path query parameter is required' }, 400);
  }

  const resolved = path.resolve(filePath);

  try {
    await fs.access(resolved);
  } catch {
    return c.json({ error: 'File does not exist' }, 404);
  }

  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    return c.json({ error: 'Path is not a file' }, 400);
  }

  const truncated = stat.size > MAX_FILE_SIZE;

  try {
    const buffer = await fs.readFile(resolved, { 
      flag: 'r',
    });

    if (isBinaryContent(buffer)) {
      return c.json({
        content: null,
        language: null,
        size: stat.size,
        truncated: false,
        binary: true,
      });
    }

    const content = truncated
      ? buffer.subarray(0, MAX_FILE_SIZE).toString('utf-8')
      : buffer.toString('utf-8');

    return c.json({
      content,
      language: detectLanguage(filePath),
      size: stat.size,
      truncated,
      binary: false,
    });
  } catch (e) {
    return c.json({ error: 'Failed to read file' }, 500);
  }
});

files.put('/write', async (c) => {
  try {
    const { filePath, content } = await c.req.json();
    if (!filePath || content === undefined) {
      return c.json({ error: 'filePath and content are required' }, 400);
    }

    const resolved = path.resolve(filePath);

    // Ensure parent directory exists
    const parentDir = path.dirname(resolved);
    await fs.mkdir(parentDir, { recursive: true });

    // Read old content for diff (if file exists)
    let oldContent: string | null = null;
    try {
      const oldBuffer = await fs.readFile(resolved);
      oldContent = oldBuffer.toString('utf-8');
    } catch { /* file doesn't exist yet */ }

    await fs.writeFile(resolved, content, 'utf-8');

    return c.json({
      success: true,
      path: resolved,
      isNew: oldContent === null,
      size: Buffer.byteLength(content, 'utf-8'),
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed to write file' }, 500);
  }
});

export default files;
