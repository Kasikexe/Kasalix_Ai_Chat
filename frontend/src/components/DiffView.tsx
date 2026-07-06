import { useMemo } from 'react';
import { Plus, Minus } from 'lucide-react';

interface DiffLine {
  type: 'add' | 'remove' | 'same';
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

interface Props {
  oldContent: string;
  newContent: string;
  filename?: string;
}

function computeDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  // Simple LCS-based diff
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const result: DiffLine[] = [];
  let i = m, j = n;
  const temp: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      temp.push({ type: 'same', oldLine: i, newLine: j, content: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      temp.push({ type: 'add', oldLine: null, newLine: j, content: newLines[j - 1] });
      j--;
    } else {
      temp.push({ type: 'remove', oldLine: i, newLine: null, content: oldLines[i - 1] });
      i--;
    }
  }

  // Reverse to get correct order
  for (let k = temp.length - 1; k >= 0; k--) {
    result.push(temp[k]);
  }

  return result;
}

export function DiffView({ oldContent, newContent, filename }: Props) {
  const diff = useMemo(() => {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    return computeDiff(oldLines, newLines);
  }, [oldContent, newContent]);

  const added = diff.filter((l) => l.type === 'add').length;
  const removed = diff.filter((l) => l.type === 'remove').length;

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      {/* Summary bar */}
      <div className="flex items-center gap-3 px-3 py-1.5 bg-gray-800/80 border-b border-gray-700 text-xs">
        {filename && <span className="text-gray-300 font-medium truncate">{filename}</span>}
        <span className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1 text-green-400">
            <Plus size={12} /> {added} added
          </span>
          <span className="flex items-center gap-1 text-red-400">
            <Minus size={12} /> {removed} removed
          </span>
        </span>
      </div>

      {/* Diff lines */}
      <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
        <table className="w-full text-[11px] font-mono leading-relaxed">
          <tbody>
            {diff.map((line, idx) => (
              <tr
                key={idx}
                className={`${
                  line.type === 'add' ? 'bg-green-950/40' :
                  line.type === 'remove' ? 'bg-red-950/40' :
                  ''
                }`}
              >
                <td className="w-10 text-right pr-2 text-gray-600 select-none border-r border-gray-800">
                  {line.oldLine ?? ''}
                </td>
                <td className="w-10 text-right pr-2 text-gray-600 select-none border-r border-gray-800">
                  {line.newLine ?? ''}
                </td>
                <td className="w-4 text-center select-none">
                  {line.type === 'add' ? (
                    <span className="text-green-400">+</span>
                  ) : line.type === 'remove' ? (
                    <span className="text-red-400">−</span>
                  ) : (
                    <span className="text-gray-600">&nbsp;</span>
                  )}
                </td>
                <td className={`pl-2 whitespace-pre ${
                  line.type === 'add' ? 'text-green-300' :
                  line.type === 'remove' ? 'text-red-300' :
                  'text-gray-400'
                }`}>
                  {line.content || ' '}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
