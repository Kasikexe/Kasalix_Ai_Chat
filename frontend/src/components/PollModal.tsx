import { useEffect, useState, useCallback, useRef } from 'react';
import { X, BarChart3, Loader2, ExternalLink, RotateCw } from 'lucide-react';
import { openExternal } from '../utils/openExternal';
import {
  fetchPoll,
  submitVote,
  POLL_SITE_URL,
  POLL_VOTED_STORAGE_KEY,
  type PollPayload,
} from '../utils/poll';

interface Props {
  open: boolean;
  onClose: () => void;
}

const REFRESH_MS = 5000;

export function PollModal({ open, onClose }: Props) {
  const [data, setData] = useState<PollPayload | null>(null);
  const [votedOption, setVotedOption] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const restoredRef = useRef(false);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const payload = await fetchPoll();
      setData(payload);
      setError(null);
    } catch {
      // Keep the last known results on transient errors
      setError('Could not load the poll. Check your internet connection.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on open + refresh every few seconds while open (paused while voting)
  useEffect(() => {
    if (!open) return;
    refresh();
    const interval = setInterval(() => {
      if (!submittingRef.current) refresh(true);
    }, REFRESH_MS);
    return () => clearInterval(interval);
  }, [open, refresh]);

  // Restore this device's vote once per open, after the options are known
  useEffect(() => {
    if (!open) {
      restoredRef.current = false;
      return;
    }
    if (!data || restoredRef.current) return;
    restoredRef.current = true;
    try {
      const stored = window.localStorage.getItem(POLL_VOTED_STORAGE_KEY);
      if (stored && data.options.some((o) => o.id === stored)) {
        setVotedOption(stored);
      } else if (stored) {
        // Poll rotated — forget the stale vote
        window.localStorage.removeItem(POLL_VOTED_STORAGE_KEY);
      }
    } catch {
      /* storage may be unavailable — ignore */
    }
  }, [open, data]);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const vote = async (optionId: string) => {
    if (votedOption || submitting) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const payload = await submitVote(optionId);
      setData(payload);
      setVotedOption(optionId);
      try {
        window.localStorage.setItem(POLL_VOTED_STORAGE_KEY, optionId);
      } catch {
        /* ignore */
      }
      setError(null);
    } catch {
      setError('Could not submit your vote. Please try again.');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const options = data?.options ?? [];
  const counts = data?.counts ?? {};
  const total = options.reduce((sum, o) => sum + (counts[o.id] ?? 0), 0);
  const hasVoted = Boolean(votedOption);
  const closed = data ? !data.enabled : false;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md max-h-[88vh] flex flex-col bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between p-5 pb-3 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-600/20 rounded-xl">
              <BarChart3 size={20} className="text-blue-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Community Poll</h2>
              <p className="text-xs text-gray-500 mt-0.5">Same poll as the Kasalix website</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-800 rounded-xl text-gray-400 hover:text-gray-200 transition-colors"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading && !data ? (
            <div className="flex items-center justify-center py-10 text-gray-500">
              <Loader2 size={20} className="animate-spin mr-2" />
              Loading poll…
            </div>
          ) : error && !data ? (
            <div className="flex flex-col items-center py-10 text-center">
              <BarChart3 size={36} className="text-gray-700 mb-3" />
              <p className="text-sm text-gray-500 mb-4">{error}</p>
              <button
                onClick={() => refresh()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors"
              >
                <RotateCw size={12} />
                Try again
              </button>
            </div>
          ) : data && closed ? (
            <div className="flex flex-col items-center py-10 text-center">
              <BarChart3 size={36} className="text-gray-700 mb-3" />
              <p className="text-sm text-gray-300 font-medium mb-1">Poll closed</p>
              <p className="text-xs text-gray-500">
                We're not running a community poll right now. Check back soon!
              </p>
            </div>
          ) : data ? (
            <>
              {/* Label + live badge */}
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs text-gray-500">Community poll</p>
                  <h3 className="text-base font-semibold text-white mt-0.5 leading-snug">
                    {data.label}
                  </h3>
                </div>
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium bg-emerald-900/30 text-emerald-300 border border-emerald-800/60 shrink-0">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  </span>
                  Live
                </span>
              </div>

              {error && !hasVoted && <p className="text-xs text-red-400">{error}</p>}

              {/* Options / results */}
              <div className="space-y-2.5">
                {options.map((option) => {
                  const count = counts[option.id] ?? 0;
                  const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
                  const isPicked = votedOption === option.id;

                  if (hasVoted) {
                    return (
                      <div
                        key={option.id}
                        className={`rounded-xl border p-3.5 transition-colors ${
                          isPicked
                            ? 'border-blue-700/60 bg-blue-900/20'
                            : 'border-gray-800 bg-gray-800/20'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium text-gray-200">{option.title}</span>
                          <span className="shrink-0 text-xs tabular-nums text-gray-500">
                            {count.toLocaleString()} · {percentage}%
                          </span>
                        </div>
                        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-800">
                          <div
                            className={`h-full rounded-full transition-all duration-700 ease-out ${
                              isPicked ? 'bg-blue-500' : 'bg-gray-600'
                            }`}
                            style={{ width: `${percentage}%` }}
                          />
                        </div>
                      </div>
                    );
                  }

                  return (
                    <button
                      key={option.id}
                      onClick={() => vote(option.id)}
                      disabled={submitting}
                      className="group w-full text-left rounded-xl border border-gray-800 bg-gray-800/20 p-3.5 transition-all hover:border-gray-700 hover:bg-gray-800/40 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-200">{option.title}</p>
                          <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                            {option.description}
                          </p>
                        </div>
                        <span className="mt-0.5 shrink-0 inline-flex items-center rounded-md border border-gray-700 px-2.5 py-1 text-xs font-medium text-gray-400 transition-colors group-hover:border-blue-700/60 group-hover:text-blue-300">
                          Vote
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Footer */}
              <div className="flex flex-col gap-1.5 border-t border-gray-800 pt-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-gray-500">
                    {loading
                      ? 'Refreshing…'
                      : total > 0
                        ? `${total.toLocaleString()} total votes`
                        : 'No votes yet — be the first!'}
                  </p>
                  <button
                    onClick={() => openExternal(`${POLL_SITE_URL}/vote`)}
                    className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    <ExternalLink size={11} />
                    Vote on the website
                  </button>
                </div>
                <p className="text-[10px] text-gray-600">
                  {hasVoted
                    ? 'Thanks for voting — results update live.'
                    : 'One vote per device. Votes count together with the website.'}
                </p>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
