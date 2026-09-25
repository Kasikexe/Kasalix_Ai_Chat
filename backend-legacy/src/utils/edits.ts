// ─── Line diff engine (Myers, O(ND)) ───────────────────────────────────
// A small real line-diff so we can MEASURE how much a proposed change really
// alters a file (instead of comparing lines positionally, which makes a
// shifted file look 100% different). Used to (a) decide whether a "rewrite"
// is actually a tiny edit, (b) render accurate minimal diffs everywhere.

export interface DiffHunk {
  /** 0-based line index into the old text */
  oldStart: number;
  oldCount: number;
  /** 0-based line index into the new text */
  newStart: number;
  newCount: number;
}

/**
 * Myers line diff. Returns hunks describing the minimal edit from `a` to `b`,
 * or null when the edit distance D exceeds `maxD` (texts too different —
 * treated as a full rewrite). Correctly handles shifted lines (insertions /
 * deletions anywhere in the file).
 */
export function diffLines(a: string[], b: string[], maxD = 400): DiffHunk[] | null {
  const N = a.length;
  const M = b.length;
  const max = N + M;
  const offset = max;
  const V = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  let foundD = -1;

  outer: for (let d = 0; d <= maxD; d++) {
    trace.push(V.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && V[offset + k - 1] < V[offset + k + 1])) {
        x = V[offset + k + 1]; // insertion into b (move down)
      } else {
        x = V[offset + k - 1] + 1; // deletion from a (move right)
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      V[offset + k] = x;
      if (x >= N && y >= M) { foundD = d; break outer; }
    }
  }
  if (foundD === -1) return null;

  // Backtrack from (N, M) to reconstruct the edit.
  const hunks: DiffHunk[] = [];
  let x = N, y = M;
  for (let d = foundD; d > 0; d--) {
    const Vp = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && Vp[offset + k - 1] < Vp[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = Vp[offset + prevK];
    const prevY = prevX - prevK;
    // Walk the equal-lines snake.
    while (x > prevX && y > prevY) { x--; y--; }
    if (x === prevX) {
      hunks.unshift({ oldStart: prevX, oldCount: 0, newStart: prevY, newCount: y - prevY });
      y = prevY;
    } else {
      hunks.unshift({ oldStart: prevX, oldCount: x - prevX, newStart: prevY, newCount: 0 });
      x = prevX;
    }
  }

  // Merge adjacent hunks into single replace blocks (delete + insert at the
  // same position become one hunk).
  const merged: DiffHunk[] = [];
  for (const h of hunks) {
    const last = merged[merged.length - 1];
    if (last && last.oldStart + last.oldCount === h.oldStart && last.newStart + last.newCount === h.newStart) {
      last.oldCount += h.oldCount;
      last.newCount += h.newCount;
    } else {
      merged.push({ oldStart: h.oldStart, oldCount: h.oldCount, newStart: h.newStart, newCount: h.newCount });
    }
  }
  return merged;
}

/**
 * How many lines actually differ between two texts (EOLs normalized by caller).
 * `count` = total removed+added lines across hunks; `total` = bigger of the two
 * line counts; `hunks` is null when the texts differ too much to diff.
 */
export function changedLineCount(a: string, b: string): { count: number; total: number; hunks: DiffHunk[] | null } {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const hunks = diffLines(aLines, bLines);
  if (!hunks) return { count: Infinity, total: Math.max(aLines.length, bLines.length), hunks: null };
  return {
    count: hunks.reduce((s, h) => s + h.oldCount + h.newCount, 0),
    total: Math.max(aLines.length, bLines.length),
    hunks,
  };
}

/**
 * Shared search/replace edit engine.
 *
 * Used by BOTH the agent loop's `edit_file` tool and the `/api/files/edit`
 * endpoint, so a targeted edit behaves identically everywhere.
 *
 * Matching strategy:
 * 1. Exact substring match — if found exactly once, replace it.
 * 2. If not found, retry with per-line whitespace normalization (collapse
 *    runs of whitespace, trim each line) so the model's snippet still lands
 *    even if indentation drifted slightly.
 * 3. If still not found, return a descriptive error the caller can feed back
 *    to the model so it can retry with the exact current content.
 */

export interface EditResult {
  ok: boolean;
  newContent?: string;
  error?: string;
  /** 0 = not found, 1 = replaced, >1 = ambiguous */
  matches?: number;
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

/** Count how many times needle occurs in haystack (non-overlapping). */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Apply a search/replace edit to `content`.
 * oldString must be unique within the file (or whitespace-equivalent).
 */
export function applySearchReplace(content: string, oldString: string, newString: string): EditResult {
  if (!oldString || oldString.length === 0) {
    return { ok: false, error: 'oldString must not be empty.', matches: 0 };
  }

  // 1. Exact match
  const exact = countOccurrences(content, oldString);
  if (exact === 1) {
    // Deleting? If the oldString sits on its own line(s), remove the whole
    // line(s) — not just the substring — so no stray blank line remains.
    if (newString === '') {
      const idx = content.indexOf(oldString);
      const before = content.slice(0, idx);
      const after = content.slice(idx + oldString.length);
      const lineStart = before.lastIndexOf('\n') + 1; // start of the matched line
      // oldString ends exactly at a line boundary (next char is \n or EOF)
      const endsAtLineEnd = after === '' || after.startsWith('\n');
      const isOwnLine = before.slice(lineStart).trim() === '' && endsAtLineEnd;
      if (isOwnLine) {
        // Remove from line start through the trailing newline (if any)
        const removeEnd = after.startsWith('\n') ? idx + oldString.length + 1 : idx + oldString.length;
        return { ok: true, newContent: before.slice(0, lineStart) + after.slice(removeEnd - idx - oldString.length), matches: 1 };
      }
    }
    return { ok: true, newContent: content.replace(oldString, newString), matches: 1 };
  }
  if (exact > 1) {
    return {
      ok: false,
      matches: exact,
      error: `Found ${exact} identical occurrences of the search text — include more surrounding context to make it unique.`,
    };
  }

  // 2. Whitespace-tolerant line-based match.
  // Normalize \r so CRLF files keep consistent line endings, and treat an
  // empty newString as a true deletion (remove the matched lines entirely).
  const contentLines = content.split('\n').map((l) => l.replace(/\r$/, ''));
  const oldLines = oldString.split('\n').map((l) => l.replace(/\r$/, ''));
  const normOld = oldLines.map(normalizeLine);

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normalizeLine(contentLines[i + j]) !== normOld[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      // Check for ambiguity: more than one location matches after normalization
      let altMatch = false;
      for (let k = i + 1; k <= contentLines.length - oldLines.length && !altMatch; k++) {
        let m = true;
        for (let j = 0; j < oldLines.length; j++) {
          if (normalizeLine(contentLines[k + j]) !== normOld[j]) { m = false; break; }
        }
        if (m) altMatch = true;
      }
      if (altMatch) {
        return {
          ok: false,
          matches: 2,
          error: 'Found multiple occurrences (differing only in whitespace) — include more surrounding context to make it unique.',
        };
      }

      // Empty replacement = deletion of the matched lines
      const replacement = newString === '' ? [] : newString.split('\n');
      const newContent = [
        ...contentLines.slice(0, i),
        ...replacement,
        ...contentLines.slice(i + oldLines.length),
      ].join('\n');
      return { ok: true, newContent, matches: 1 };
    }
  }

  // 3. Not found
  return {
    ok: false,
    matches: 0,
    error:
      'Could not find the search text in the file. The file may have changed — read the current file content and retry with the exact text. Tip: include a couple of surrounding lines for uniqueness.',
  };
}
