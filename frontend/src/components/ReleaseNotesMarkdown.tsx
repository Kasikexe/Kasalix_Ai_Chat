import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  content: string;
  /** Tone of the accent colors — 'purple' for the changelog, 'emerald'/'red' for the update banner. */
  accent?: 'purple' | 'emerald' | 'red';
}

const ACCENTS = {
  purple: {
    code: 'text-purple-300',
    strong: 'text-gray-200',
  },
  emerald: {
    code: 'text-emerald-300',
    strong: 'text-emerald-50',
  },
  red: {
    code: 'text-red-300',
    strong: 'text-red-50',
  },
} as const;

/**
 * Shared renderer for GitHub release-note markdown.
 * Used by the Changelog view and the update notification banner.
 */
export function ReleaseNotesMarkdown({ content, accent = 'purple' }: Props) {
  const c = ACCENTS[accent];
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 text-xs">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 text-xs">{children}</ol>,
        li: ({ children }) => {
          const text = String(children);
          const isChecklist = text.startsWith('[ ]') || text.startsWith('[x]');
          if (isChecklist) {
            const checked = text.startsWith('[x]');
            return (
              <li className="flex items-start gap-1.5 text-xs">
                <span className={`mt-0.5 w-3.5 h-3.5 rounded flex-shrink-0 flex items-center justify-center text-[8px] ${
                  checked ? 'bg-emerald-600/30 text-emerald-400' : 'bg-gray-700/50 text-gray-500'
                }`}>{checked ? '✓' : ''}</span>
                <span>{text.slice(3)}</span>
              </li>
            );
          }
          return <li className="text-xs">{children}</li>;
        },
        p: ({ children }) => <p className="text-xs mb-1.5 last:mb-0">{children}</p>,
        strong: ({ children }) => <strong className={`${c.strong} font-semibold`}>{children}</strong>,
        code: ({ children }) => (
          <code className={`bg-gray-800 px-1 py-0.5 rounded text-[10px] font-mono ${c.code}`}>{children}</code>
        ),
        h1: ({ children }) => <h1 className="text-sm font-bold text-gray-200 mt-3 mb-1">{children}</h1>,
        h2: ({ children }) => <h2 className="text-xs font-bold text-gray-200 mt-2 mb-1">{children}</h2>,
        h3: ({ children }) => <h3 className="text-[11px] font-bold text-gray-200 mt-2 mb-0.5">{children}</h3>,
        hr: () => <hr className="border-gray-700 my-2" />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
