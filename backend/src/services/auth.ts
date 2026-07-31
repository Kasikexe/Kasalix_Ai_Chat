/**
 * Authentication service for Kasalix.
 *
 * Provides:
 * - Password hashing & verification via Bun.password (Argon2id)
 * - Secure session token management
 * - Rate limiting with temporary lockout
 * - User account storage (file-based JSON)
 *
 * Security guarantees:
 * - Passwords are NEVER stored in plaintext
 * - Password hashes are NEVER exposed to clients
 * - Session tokens are cryptographically random (UUID v4)
 * - Tokens expire after SESSION_TTL_MS (default 24h)
 * - Failed login attempts are rate-limited per IP
 */

import { promises as fs } from 'fs';
import path from 'path';
import { logger } from './logger';

// ─── Configuration ───────────────────────────────────────
const USERS_FILE = path.join(process.cwd(), 'data', 'users.json');
const SESSIONS_FILE = path.join(process.cwd(), 'data', 'sessions.json');
const DATA_DIR = path.dirname(USERS_FILE);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 86_400_000; // 24h default
const REMEMBER_ME_TTL_MS = Number(process.env.REMEMBER_ME_TTL_MS) || 2_592_000_000; // 30 days
const MAX_LOGIN_ATTEMPTS = Number(process.env.MAX_LOGIN_ATTEMPTS) || 5;
const LOCKOUT_DURATION_MS = Number(process.env.LOCKOUT_DURATION_MS) || 900_000; // 15 min

// ─── Types ───────────────────────────────────────────────
export interface StoredUser {
  id: string;           // Same user ID format as existing system (e.g. "user_xxx_name")
  username: string;
  passwordHash: string;
  color: string;
  createdAt: number;
  updatedAt: number;
}

interface Session {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

interface RateLimitEntry {
  count: number;
  firstAttempt: number;
  lockedUntil: number | null;
}

// ─── In-Memory State ─────────────────────────────────────
let users: Map<string, StoredUser> = new Map();       // key: username (lowercase)
let userIdIndex: Map<string, string> = new Map();      // key: userId -> username
let sessions: Map<string, Session> = new Map();        // key: token
let rateLimitMap: Map<string, RateLimitEntry> = new Map(); // key: IP
let initialized = false;

// Periodic session cleanup every 10 minutes
const CLEANUP_INTERVAL = 600_000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

// ─── File Operations ────────────────────────────────────
async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadUsers(): Promise<void> {
  if (initialized) return;
  try {
    await ensureDir();
    const data = await fs.readFile(USERS_FILE, 'utf-8');
    const parsed: Record<string, StoredUser> = JSON.parse(data);
    users = new Map();
    userIdIndex = new Map();
    for (const [key, user] of Object.entries(parsed)) {
      users.set(key, user);
      userIdIndex.set(user.id, key);
    }
    logger.info(`[auth] Loaded ${users.size} user(s)`);
  } catch {
    users = new Map();
    userIdIndex = new Map();
    logger.info('[auth] No existing users — starting fresh');
  }
  initialized = true;
}

async function saveUsers(): Promise<void> {
  await ensureDir();
  const obj = Object.fromEntries(users);
  await fs.writeFile(USERS_FILE, JSON.stringify(obj, null, 2));
}

// ─── Password Hashing (Argon2id) ─────────────────────────
// Uses Bun's built-in password hashing with Argon2id algorithm.
// Salt is automatically generated and included in the output hash.
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, {
    algorithm: 'argon2id',
    // Default parameters: m=65536, t=2, p=1 — good balance of security & speed
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

// ─── Session Management ──────────────────────────────────
function generateToken(): string {
  return crypto.randomUUID();
}

function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    let expired = 0;
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) {
        sessions.delete(token);
        expired++;
      }
    }
    if (expired > 0) {
      logger.debug(`[auth] Cleaned up ${expired} expired session(s)`);
      queueSessionSave();
    }
  }, CLEANUP_INTERVAL);
}

function stopCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// ─── Session Persistence ───────────────────────────────
// Remember-me sessions are persisted to disk so they survive server restarts.
// Regular (24h) sessions are saved too — they simply expire on their own.
let sessionWriteChain: Promise<void> = Promise.resolve();

function queueSessionSave(): void {
  const snapshot = Array.from(sessions.values());
  sessionWriteChain = sessionWriteChain
    .then(async () => {
      await ensureDir();
      await fs.writeFile(SESSIONS_FILE, JSON.stringify(snapshot, null, 2));
    })
    .catch((err) => {
      logger.warn(`[auth] Failed to persist sessions: ${err.message}`);
    });
}

async function loadSessions(): Promise<void> {
  try {
    const data = await fs.readFile(SESSIONS_FILE, 'utf-8');
    const parsed: Session[] = JSON.parse(data);
    // Merge (set) instead of replacing: the map starts empty at boot, and any
    // session created while this read was in flight is preserved. Disk entries
    // simply overwrite same-token entries — fully race-free.
    for (const s of parsed) sessions.set(s.token, s);
    logger.info(`[auth] Loaded ${sessions.size} persisted session(s)`);
  } catch {
    // No file yet — start fresh
  }
}

export async function createSession(userId: string, rememberMe = false): Promise<string> {
  const token = generateToken();
  const now = Date.now();
  const ttl = rememberMe ? REMEMBER_ME_TTL_MS : SESSION_TTL_MS;
  const session: Session = {
    token,
    userId,
    createdAt: now,
    expiresAt: now + ttl,
  };
  sessions.set(token, session);
  queueSessionSave();
  logger.info(`[auth] Session created for user ${userId} (${rememberMe ? 'remember me · 30 days' : '24h'})`);
  return token;
}

export function validateSession(token: string): { valid: boolean; userId?: string } {
  const session = sessions.get(token);
  if (!session) return { valid: false };
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return { valid: false };
  }
  return { valid: true, userId: session.userId };
}

export function destroySession(token: string): void {
  sessions.delete(token);
  queueSessionSave();
}

export function destroyAllUserSessions(userId: string): void {
  for (const [token, session] of sessions) {
    if (session.userId === userId) {
      sessions.delete(token);
    }
  }
  queueSessionSave();
}

// ─── User Account Management ────────────────────────────
const DEFAULT_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
];

function pickColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  return DEFAULT_COLORS[Math.abs(hash) % DEFAULT_COLORS.length];
}

function hashName(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = ((hash << 5) - hash) + username.charCodeAt(i);
    hash |= 0;
  }
  return 'user_' + Math.abs(hash).toString(36) + '_' + username.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function registerUser(username: string, password: string): Promise<{ success: true; userId: string } | { success: false; error: string }> {
  await loadUsers();
  const normalized = username.trim().toLowerCase();

  if (!normalized || normalized.length < 2) {
    return { success: false, error: 'Username must be at least 2 characters' };
  }
  if (normalized.length > 24) {
    return { success: false, error: 'Username must be 24 characters or fewer' };
  }
  if (password.length < 6) {
    return { success: false, error: 'Password must be at least 6 characters' };
  }

  if (users.has(normalized)) {
    // Don't reveal whether the username exists — use generic message
    return { success: false, error: 'Registration failed' };
  }

  const userId = hashName(normalized);
  const passwordHash = await hashPassword(password);

  const user: StoredUser = {
    id: userId,
    username: normalized,
    passwordHash,
    color: pickColor(normalized),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  users.set(normalized, user);
  userIdIndex.set(userId, normalized);
  await saveUsers();

  logger.info(`[auth] User registered: ${normalized}`);
  return { success: true, userId };
}

export async function loginUser(
  username: string,
  password: string,
  ip: string,
  rememberMe = false
): Promise<{ success: true; userId: string; token: string } | { success: false; error: string }> {
  await loadUsers();

  // Check rate limit first
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return { success: false, error: 'Invalid username or password' };
  }

  const normalized = username.trim().toLowerCase();
  const user = users.get(normalized);

  if (!user) {
    recordFailedAttempt(ip);
    return { success: false, error: 'Invalid username or password' };
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    recordFailedAttempt(ip);
    logger.warn(`[auth] Failed login attempt for user: ${normalized} (IP: ${ip})`);
    return { success: false, error: 'Invalid username or password' };
  }

  // Success — reset rate limit and create session
  resetRateLimit(ip);
  const token = await createSession(user.id, rememberMe);
  logger.info(`[auth] User logged in: ${normalized}`);
  return { success: true, userId: user.id, token };
}

export async function getCurrentUser(userId: string): Promise<{ id: string; username: string; color: string } | null> {
  await loadUsers();
  const key = userIdIndex.get(userId);
  if (!key) return null;
  const user = users.get(key);
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    color: user.color,
  };
}

export async function getAllUsers(): Promise<Array<{ id: string; username: string; color: string; createdAt: number }>> {
  await loadUsers();
  const result: Array<{ id: string; username: string; color: string; createdAt: number }> = [];
  for (const user of users.values()) {
    result.push({
      id: user.id,
      username: user.username,
      color: user.color,
      createdAt: user.createdAt,
    });
  }
  // Sort by creation date (newest first)
  result.sort((a, b) => b.createdAt - a.createdAt);
  return result;
}

// ─── Rate Limiting ──────────────────────────────────────
function checkRateLimit(ip: string): { allowed: boolean } {
  const entry = rateLimitMap.get(ip);
  if (!entry) return { allowed: true };

  // Check if currently locked out
  if (entry.lockedUntil && entry.lockedUntil > Date.now()) {
    return { allowed: false };
  }

  // If lockout has expired, reset
  if (entry.lockedUntil && entry.lockedUntil <= Date.now()) {
    rateLimitMap.delete(ip);
    return { allowed: true };
  }

  return { allowed: true };
}

function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry) {
    rateLimitMap.set(ip, { count: 1, firstAttempt: now, lockedUntil: null });
    return;
  }

  // Reset counter if the window has passed (window = lockout duration)
  if (now - entry.firstAttempt > LOCKOUT_DURATION_MS) {
    rateLimitMap.set(ip, { count: 1, firstAttempt: now, lockedUntil: null });
    return;
  }

  entry.count++;

  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_DURATION_MS;
    logger.warn(`[auth] Rate limit exceeded for IP: ${ip} — locked out for ${LOCKOUT_DURATION_MS / 60000} min`);
  }
}

function resetRateLimit(ip: string): void {
  rateLimitMap.delete(ip);
}

// ─── Cleanup on shutdown ────────────────────────────────
export function shutdown(): void {
  stopCleanup();
  logger.info('[auth] Auth service shut down');
}

// Load persisted sessions (so remember-me logins survive restarts), then start cleanup
loadSessions().finally(() => {
  startCleanup();
});
