/**
 * Shared community poll.
 *
 * The Kasalix clients read and write the SAME poll the kasalixwebai website
 * shows (deployed at kasalixweb.vercel.app). Votes are counted in the
 * website's Redis, so app and web votes accumulate together. The poll's
 * definition (label + options + enabled) is served by the API itself, so
 * the app never needs a copy of the poll config.
 */

import { POLL_SITE_URL, POLL_API_URL } from '../config';

export { POLL_SITE_URL };

/** Same localStorage key the website uses to remember a visitor's vote. */
export const POLL_VOTED_STORAGE_KEY = 'kasalix-poll-voted';

export interface PollOption {
  id: string;
  title: string;
  description: string;
}

export interface PollPayload {
  enabled: boolean;
  label: string;
  options: PollOption[];
  counts: Record<string, number>;
}

/** Fetch the poll definition + live vote counts. */
export async function fetchPoll(): Promise<PollPayload> {
  const res = await fetch(POLL_API_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Poll request failed: ${res.status}`);
  return res.json();
}

/** Cast a vote for an option; resolves with the updated poll. */
export async function submitVote(optionId: string): Promise<PollPayload> {
  const res = await fetch(POLL_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ optionId }),
  });
  if (!res.ok) throw new Error(`Vote failed: ${res.status}`);
  return res.json();
}
