/**
 * ════════════════════════════════════════════════════════════════
 *  🏷️  BRANDING / IDENTITY CONFIG — EDIT THIS TO REBRAND A FORK
 * ════════════════════════════════════════════════════════════════
 *
 *  Everything that points back at the original Kasalix project
 *  (GitHub repo, community poll, changelog) lives here. The official
 *  build uses the defaults below; fork maintainers can override any
 *  value with Vite env vars (see `.env.example`) without editing code:
 *
 *    VITE_GITHUB_REPO    — "owner/name" of the feedback repository
 *    VITE_GITHUB_RELEASE_REPO — repository containing app releases
 *    VITE_POLL_SITE_URL  — base URL of the community poll website
 *    VITE_POLL_API_URL   — full poll API endpoint (defaults to the site)
 */

const env = (import.meta as any).env ?? {};

/** Feedback repository in "owner/name" form. */
export const GITHUB_REPO: string = env.VITE_GITHUB_REPO || 'Kasikexe/Kasalix';
/** Keep the existing fork override working unless a release repo is specified. */
export const GITHUB_RELEASE_REPO: string = env.VITE_GITHUB_RELEASE_REPO || env.VITE_GITHUB_REPO || 'Kasikexe/Kasalix_Ai_Chat';

/** Public GitHub URLs. */
export const REPO_URL = `https://github.com/${GITHUB_REPO}`;
export const NEW_ISSUE_URL = `${REPO_URL}/issues/new`;
export const IDEAS_URL = `${REPO_URL}/discussions/categories/ideas`;
export const RELEASES_URL = `https://github.com/${GITHUB_RELEASE_REPO}/releases`;

/** GitHub Releases API for the configured repo (changelog). */
export const GITHUB_RELEASES_API = `https://api.github.com/repos/${GITHUB_RELEASE_REPO}/releases`;

/** Community poll — the website serves the poll definition + live counts. */
export const POLL_SITE_URL: string =
  env.VITE_POLL_SITE_URL || 'https://kasalixweb.vercel.app';
export const POLL_API_URL: string = env.VITE_POLL_API_URL || `${POLL_SITE_URL}/api/poll`;
