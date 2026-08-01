import { promises as fs } from 'fs';
import path from 'path';
import zlib from 'zlib';
import { chat } from './ollama';
import { getModelAssignment } from './model-assignments';
import { getDataDir } from '../utils/helpers';
import type { Message } from '../types';

// ─── Model Assignment Keys ──────────────────────────────────
// These match the keys in model-assignments.ts
export type ModelAssignmentKey =
  | 'chat_fast'
  | 'chat_thinking'
  | 'code'
  | 'vision'
  | 'search'
  | 'extraction';

const ASSIGNMENT_LABELS: Record<ModelAssignmentKey, string> = {
  chat_fast: 'Chat (Fast)',
  chat_thinking: 'Chat (Thinking)',
  code: 'Code Generation',
  vision: 'Vision Analysis',
  search: 'Web Search',
  extraction: 'Memory Extraction',
};

const ASSIGNMENT_ICONS: Record<ModelAssignmentKey, string> = {
  chat_fast: '⚡',
  chat_thinking: '🧠',
  code: '💻',
  vision: '👁️',
  search: '🌐',
  extraction: '📝',
};

// ─── Test Image Generation ──────────────────────────────────
// Generate a small PNG test image of a fox for vision model testing.

const DATA_DIR = path.join(getDataDir(), 'speedtest');
const TEST_IMAGE_PATH = path.join(DATA_DIR, 'test_fox.png');

/**
 * Create a 64x64 PNG image of a simple fox face.
 * Uses raw pixel data + zlib DEFLATE compression to build a valid PNG.
 */
function createFoxPng(): Buffer {
  const width = 64;
  const height = 64;
  const channels = 4; // RGBA

  // Build raw pixel data
  const rawPixels = Buffer.alloc(height * (1 + width * channels));

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * channels);
    rawPixels[rowOffset] = 0; // filter byte: None

    for (let x = 0; x < width; x++) {
      const px = rowOffset + 1 + x * channels;

      // Normalized coords (-1 to 1) centered on image
      const nx = (x / width) * 2 - 1;
      const ny = (y / height) * 2 - 1;
      const distCenter = Math.sqrt(nx * nx + ny * ny);

      // Fox face shape — oval at center
      const inFace = (nx * nx) / 0.45 + (ny * ny) / 0.6 <= 1;

      // Fox ears — two triangles at top
      const leftEar = nx < -0.3 && ny < -0.55 && ny > -0.85 && Math.abs(nx + 0.55) < (0.3 - (ny + 0.85) * 0.8);
      const rightEar = nx > 0.3 && ny < -0.55 && ny > -0.85 && Math.abs(nx - 0.55) < (0.3 - (ny + 0.85) * 0.8);

      // Eyes — two small dark dots
      const leftEye = Math.abs(nx + 0.25) < 0.08 && Math.abs(ny - 0.1) < 0.08;
      const rightEye = Math.abs(nx - 0.25) < 0.08 && Math.abs(ny - 0.1) < 0.08;

      // Nose — small triangle at bottom center
      const nose = Math.abs(nx) < 0.06 && ny > 0.15 && ny < 0.25;

      // White muzzle area
      const muzzle = inFace && ny > 0.05 && Math.abs(nx) < 0.2;

      // Background
      const bgGradient = 30 + Math.round((1 - distCenter) * 30);

      if (leftEar || rightEar) {
        // Ears: dark orange/brown
        rawPixels[px] = 180;
        rawPixels[px + 1] = 80;
        rawPixels[px + 2] = 30;
        rawPixels[px + 3] = 255;
      } else if (leftEye || rightEye) {
        // Eyes: dark brown/black
        rawPixels[px] = 20;
        rawPixels[px + 1] = 15;
        rawPixels[px + 2] = 10;
        rawPixels[px + 3] = 255;
      } else if (nose) {
        // Nose: dark
        rawPixels[px] = 40;
        rawPixels[px + 1] = 25;
        rawPixels[px + 2] = 15;
        rawPixels[px + 3] = 255;
      } else if (muzzle) {
        // Muzzle: white/cream
        rawPixels[px] = 240;
        rawPixels[px + 1] = 230;
        rawPixels[px + 2] = 215;
        rawPixels[px + 3] = 255;
      } else if (inFace) {
        // Fox fur: orange
        const furNoise = Math.sin(x * 3.7 + y * 5.1) * 15;
        rawPixels[px] = 210 + Math.round(furNoise);
        rawPixels[px + 1] = 120 + Math.round(furNoise * 0.5);
        rawPixels[px + 2] = 40;
        rawPixels[px + 3] = 255;
      } else {
        // Background: soft blue-green
        rawPixels[px] = bgGradient;
        rawPixels[px + 1] = bgGradient + 40;
        rawPixels[px + 2] = bgGradient + 60;
        rawPixels[px + 3] = 255;
      }
    }
  }

  // Compress with zlib (deflate)
  const compressed = zlib.deflateSync(rawPixels);

  // Build PNG chunks
  function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c;
    }
    for (let i = 0; i < buf.length; i++) {
      crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type, 'ascii');
    const crcData = Buffer.concat([typeB, data]);
    const crcVal = crc32(crcData);
    const crcB = Buffer.alloc(4);
    crcB.writeUInt32BE(crcVal);
    return Buffer.concat([len, typeB, data, crcB]);
  }

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Build final PNG
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Get the test fox image as a base64 data URL string.
 * Generates the image on first call and caches it to disk for subsequent runs.
 */
async function getTestImageBase64(): Promise<string> {
  let imageBuffer: Buffer;

  try {
    // Try reading cached image from disk
    imageBuffer = await fs.readFile(TEST_IMAGE_PATH);
  } catch {
    // Generate and cache the image
    await fs.mkdir(DATA_DIR, { recursive: true });
    imageBuffer = createFoxPng();
    await fs.writeFile(TEST_IMAGE_PATH, imageBuffer);
    console.log(`[speedtest] Generated test fox image (${(imageBuffer.length / 1024).toFixed(1)} KB)`);
  }

  return `data:image/png;base64,${imageBuffer.toString('base64')}`;
}

// ─── Test Definitions ───────────────────────────────────────

export interface SpeedTestDefinition {
  id: string;
  name: string;
  description: string;
  /** Which model assignment to use for this test */
  assignmentKey: ModelAssignmentKey;
  category: 'simple' | 'search' | 'code' | 'long' | 'vision';
  /** Whether this test needs the fox image injected */
  needsImage?: boolean;
  messages: Message[];
}

export const SPEED_TESTS: SpeedTestDefinition[] = [
  // ─── Chat Fast (⚡) — simple, fast responses ─────────────
  {
    id: 'greeting',
    name: 'Greeting',
    description: 'Basic welcome message — tests fast chat response time',
    assignmentKey: 'chat_fast',
    category: 'simple',
    messages: [
      { role: 'system', content: 'You are a helpful AI assistant. Respond concisely in 1-2 sentences.' },
      { role: 'user', content: 'Hello! How are you today?' },
    ],
  },
  {
    id: 'quick-fact',
    name: 'Quick Fact',
    description: 'Simple factual question — tests basic knowledge retrieval',
    assignmentKey: 'chat_fast',
    category: 'simple',
    messages: [
      { role: 'system', content: 'You are a helpful AI assistant. Respond concisely.' },
      { role: 'user', content: 'What is the capital of France?' },
    ],
  },
  {
    id: 'follow-up',
    name: 'Short Follow-up',
    description: 'Short conversational response — tests context handling',
    assignmentKey: 'chat_fast',
    category: 'simple',
    messages: [
      { role: 'system', content: 'You are a helpful AI assistant. Respond concisely.' },
      { role: 'user', content: 'Great, thanks for your help!' },
    ],
  },

  // ─── Chat Thinking (🧠) — reasoning-heavy ────────────────
  {
    id: 'logic-puzzle',
    name: 'Logic Puzzle',
    description: 'A reasoning problem — tests thinking model depth',
    assignmentKey: 'chat_thinking',
    category: 'long',
    messages: [
      { role: 'system', content: 'You are a logical reasoning assistant. Think step by step.' },
      { role: 'user', content: 'If a train leaves Station A traveling at 60 mph and another train leaves Station B 100 miles away traveling at 40 mph towards each other, at what distance from Station A will they meet?' },
    ],
  },
  {
    id: 'math-problem',
    name: 'Math Problem',
    description: 'Multi-step calculation — tests reasoning speed',
    assignmentKey: 'chat_thinking',
    category: 'long',
    messages: [
      { role: 'system', content: 'You are a math assistant. Show your work clearly.' },
      { role: 'user', content: 'A rectangle has a perimeter of 48 cm. Its length is 6 cm longer than its width. What is the area of the rectangle?' },
    ],
  },

  // ─── Code Generation (💻) ────────────────────────────────
  {
    id: 'react-component',
    name: 'React Component',
    description: 'Generate a TypeScript React component — tests code model',
    assignmentKey: 'code',
    category: 'code',
    messages: [
      { role: 'system', content: 'You are an expert TypeScript/React developer. Generate clean, production-ready code.' },
      { role: 'user', content: 'Write a React button component in TypeScript that shows a click counter. Use useState hook and proper TypeScript types.' },
    ],
  },
  {
    id: 'api-endpoint',
    name: 'API Endpoint',
    description: 'Generate a backend API route — tests code generation for backend',
    assignmentKey: 'code',
    category: 'code',
    messages: [
      { role: 'system', content: 'You are an expert backend developer. Generate clean, working code.' },
      { role: 'user', content: 'Write a simple Express.js API endpoint that handles CRUD operations for a "tasks" resource with in-memory storage.' },
    ],
  },

  // ─── Vision Analysis (👁️) — REAL vision tests with an image ──
  // The {{IMAGE}} placeholder is replaced with the actual base64 data URL at runtime.
  {
    id: 'fox-object',
    name: 'Fox Object Detection',
    description: 'Identify objects in a test image — tests real vision processing with an image',
    assignmentKey: 'vision',
    category: 'vision',
    needsImage: true,
    messages: [
      { role: 'system', content: 'You are a vision analysis assistant. Describe what you see in the image in 2-3 sentences. Focus on: what animal is shown, its colors, and any facial features you can identify.' },
      { role: 'user', content: '[image:{{IMAGE}}] What animal do you see in this image? Describe its colors and any facial features.' },
    ],
  },
  {
    id: 'fox-color',
    name: 'Fox Color Analysis',
    description: 'Analyze colors in a test image — tests vision model color perception with an image',
    assignmentKey: 'vision',
    category: 'vision',
    needsImage: true,
    messages: [
      { role: 'system', content: 'You are a color analysis assistant. Describe the dominant colors, patterns, and any facial features you observe in the image. Be specific about color names.' },
      { role: 'user', content: '[image:{{IMAGE}}] What are the dominant colors in this image? Describe the facial features and patterns you can see.' },
    ],
  },

  // ─── Web Search (🌐) — tests search summarization speed ──
  {
    id: 'news-summary',
    name: 'News Summary',
    description: 'Summarize search-like content — tests search model',
    assignmentKey: 'search',
    category: 'search',
    messages: [
      { role: 'system', content: 'You are a precise web search summarizer. Extract and report only facts explicitly stated.' },
      { role: 'user', content: 'Based on the following information: "The 2024 Summer Olympics were held in Paris, France. Over 10,000 athletes from 206 nations participated. The games featured 32 sports including new additions like breaking (breakdancing)." Summarize the key facts.' },
    ],
  },
  {
    id: 'tech-trends',
    name: 'Tech Trends',
    description: 'Summarize technical information — tests search model comprehension',
    assignmentKey: 'search',
    category: 'search',
    messages: [
      { role: 'system', content: 'You are a technical research summarizer. Report facts accurately.' },
      { role: 'user', content: 'Summarize: "TypeScript 5.5 introduced inferred type predicates. React 19 added server components and actions. Bun 1.1 improved Windows support and Node.js compatibility."' },
    ],
  },

  // ─── Memory Extraction (📝) — tests extraction speed ────
  {
    id: 'extract-info',
    name: 'Extract Info',
    description: 'Extract personal information from text — tests extraction model',
    assignmentKey: 'extraction',
    category: 'simple',
    messages: [
      { role: 'system', content: 'Extract personal information about the user from their message. Output JSON with categories.' },
      { role: 'user', content: 'Hi! My name is Sarah Johnson. I am a 28-year-old software engineer from San Francisco. I enjoy hiking and playing the piano in my free time. I work on machine learning projects.' },
    ],
  },
];

// ─── Quality Checks ───────────────────────────────────────────
// Each test can have multiple quality checks that evaluate the response content.

export interface QualityCheckResult {
  /** Name of the check */
  name: string;
  /** Whether the check passed */
  passed: boolean;
  /** Optional detail message */
  details?: string;
}

type QualityCheckFn = (response: string) => QualityCheckResult;

/**
 * Per-test quality checks. Keyed by test ID.
 * Each check receives the full response text and returns pass/fail.
 */
const QUALITY_CHECKS: Record<string, QualityCheckFn[]> = {
  'greeting': [
    (r) => ({ name: 'Not empty', passed: r.trim().length > 0, details: r.trim().length > 0 ? `${r.trim().length} chars` : 'Empty response' }),
    (r) => ({ name: 'Has greeting', passed: /\b(hello|hi\b|hey|howdy|greetings)\b/i.test(r), details: /\b(hello|hi\b|hey|howdy|greetings)\b/i.exec(r)?.[0] || undefined }),
  ],
  'quick-fact': [
    (r) => ({ name: 'Not empty', passed: r.trim().length > 0 }),
    (r) => ({ name: 'Mentions Paris', passed: /\bparis\b/i.test(r), details: /\bparis\b/i.test(r) ? 'Found "Paris"' : 'Missing "Paris"' }),
    (r) => ({ name: 'Mentions France', passed: /\bfrance\b/i.test(r), details: /\bfrance\b/i.test(r) ? 'Found "France"' : undefined }),
  ],
  'follow-up': [
    (r) => ({ name: 'Not empty', passed: r.trim().length > 0 }),
    (r) => ({ name: 'Friendly tone', passed: /\b(you'?re welcome|thanks|glad|happy|welcome|anytime|pleasure|no problem|my pleasure)\b/i.test(r) }),
  ],
  'logic-puzzle': [
    (r) => ({ name: 'Not empty', passed: r.trim().length > 0 }),
    (r) => ({ name: 'Correct distance', passed: /\b60\b/.test(r) && /\b(mile|mi\.?)\b/i.test(r), details: /\b60\b/.test(r) ? 'Found "60" in response' : 'Missing distance "60"' }),
  ],
  'math-problem': [
    (r) => ({ name: 'Not empty', passed: r.trim().length > 0 }),
    (r) => ({ name: 'Correct area', passed: /\b135\b/.test(r), details: /\b135\b/.test(r) ? 'Found "135"' : 'Missing "135" (expected area)' }),
  ],
  'react-component': [
    (r) => ({ name: 'Not empty', passed: r.trim().length > 0 }),
    (r) => ({ name: 'Uses useState', passed: /\buseState\b/.test(r), details: /\buseState\b/.test(r) ? 'Found useState' : 'Missing useState' }),
    (r) => ({ name: 'TypeScript types', passed: /:\s*(string|number|boolean|void|React\.|Props|interface|type\s)/.test(r), details: /:\s*(string|number|boolean)/.test(r) ? 'Has type annotations' : 'May lack TypeScript types' }),
    (r) => ({ name: 'React component', passed: /\b(React|const\s+\w+:|function\s+\w+)/.test(r) }),
  ],
  'api-endpoint': [
    (r) => ({ name: 'Not empty', passed: r.trim().length > 0 }),
    (r) => ({ name: 'Express routes', passed: /\.(get|post|put|delete|patch)\s*\(/.test(r), details: /\.(get|post|put|delete)\s*\(/.exec(r)?.[0] || 'No routes found' }),
    (r) => ({ name: 'CRUD operations', passed: /\b(get|post|put|delete|patch)\b.*\b(get|post|put|delete|patch)\b/i.test(r), details: 'Has multiple HTTP methods' }),
    (r) => ({ name: 'In-memory storage', passed: /\b(const|let|var)\s+\w+\s*[=:]\s*\[\s*\]|\b(const|let|var)\s+\w+\s*[=:]\s*\{\s*\}/.test(r) || /\bmemory\b/i.test(r) }),
  ],
  'fox-object': [
    (r) => ({ name: 'Not empty', passed: r.trim().length > 0 }),
    (r) => ({ name: 'Identifies animal', passed: /\b(fox|animal|creature|face|mammal)\b/i.test(r), details: /\b(fox|animal|creature|face)\b/i.exec(r)?.[0] || 'No animal mentioned' }),
    (r) => ({ name: 'Describes color', passed: /\b(orange|brown|white|black|cream|dark|ginger|amber|reddish)\b/i.test(r) }),
    (r) => ({ name: 'Mentions features', passed: /\b(ear|eye|nose|face|muzzle|fur|whisker|head|snout|triangular|pointy)\b/i.test(r) }),
  ],
  'fox-color': [
    (r) => ({ name: 'Not empty', passed: r.trim().length > 0 }),
    (r) => ({ name: 'Identifies orange', passed: /\b(orange|ginger|amber|reddish|brown)\b/i.test(r), details: /\b(orange|ginger|amber|reddish|brown)\b/i.exec(r)?.[0] || 'No orange/brown mentioned' }),
    (r) => ({ name: 'Mentions white/cream', passed: /\b(white|cream|light|pale)\b/i.test(r) }),
    (r) => ({ name: 'Describes pattern', passed: /\b(ear|eye|nose|face|muzzle|fur|stripe|pattern|marking|tip|patch)\b/i.test(r) }),
  ],
  'news-summary': [
    (r) => ({ name: 'Not empty', passed: r.trim().length > 0 }),
    (r) => ({ name: 'Mentions Paris', passed: /\bparis\b/i.test(r), details: /\bparis\b/i.test(r) ? 'Found "Paris"' : 'Missing key fact: Paris' }),
    (r) => ({ name: 'Includes numbers', passed: /\b(10,000|10000|206|32)\b/.test(r), details: /\b(10,000|10000|206|32)\b/.exec(r)?.[0] || 'No specific numbers' }),
  ],
  'tech-trends': [
    (r) => ({ name: 'Not empty', passed: r.trim().length > 0 }),
    (r) => ({ name: 'Mentions TypeScript', passed: /\btypescript\b/i.test(r), details: /\btypescript\b/i.test(r) ? 'Found TypeScript' : 'Missing TypeScript' }),
    (r) => ({ name: 'Mentions React/Server', passed: /\b(react|server\s*components)\b/i.test(r) }),
    (r) => ({ name: 'Mentions Bun', passed: /\bbun\b/i.test(r), details: /\bbun\b/i.test(r) ? 'Found Bun' : 'Missing Bun' }),
  ],
  'extract-info': [
    (r) => ({ name: 'Not empty', passed: r.trim().length > 0 }),
    (r) => ({ name: 'Contains JSON', passed: /[{]/.test(r) && /[}]/.test(r), details: /[{]/.test(r) && /[}]/.test(r) ? 'Contains JSON structure' : 'No JSON found' }),
    (r) => ({ name: 'Extracts name', passed: /\b(sarah|Johnson|Sarah Johnson)\b/i.test(r), details: /\b(sarah|Johnson)\b/i.exec(r)?.[0] || 'Name not found' }),
    (r) => ({ name: 'Extracts profession', passed: /\b(software\s*engineer|engineer|developer)\b/i.test(r) }),
  ],
};

// ─── Test Results Types ─────────────────────────────────────

export interface SingleTestResult {
  testId: string;
  testName: string;
  category: string;
  assignmentKey: ModelAssignmentKey;
  success: boolean;
  /** Total response time in ms */
  totalTimeMs: number;
  /** Time to first token in ms (estimated) */
  timeToFirstTokenMs: number;
  /** Total characters received */
  totalChars: number;
  /** Estimated tokens (chars / 4) */
  estimatedTokens: number;
  /** Tokens per second */
  tokensPerSecond: number;
  /** Model used for the test (resolved model name) */
  model: string;
  /** Error message if failed */
  error?: string;
  /** Timestamp of when the test started */
  timestamp: number;
  /** Quality score 0–100 */
  qualityScore: number;
  /** Detailed quality check results */
  qualityChecks: QualityCheckResult[];
}

export interface SpeedTestRunResult {
  id: string;
  date: string;
  timestamp: number;
  /** Duration of the entire test suite in ms */
  totalDurationMs: number;
  /** All models that were tested (assignment key -> model name) */
  models: Record<ModelAssignmentKey, string>;
  /** Number of models tested */
  modelCount: number;
  /** Individual test results */
  tests: SingleTestResult[];
  /** Summary metrics */
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    avgResponseTimeMs: number;
    avgTokensPerSecond: number;
    avgTimeToFirstTokenMs: number;
    avgQualityScore: number;
  };
  /** Per-model summaries */
  modelSummaries: Record<string, {
    model: string;
    label: string;
    icon: string;
    tests: number;
    passed: number;
    failed: number;
    avgResponseTimeMs: number;
    avgTokensPerSecond: number;
    avgQualityScore: number;
  }>;
}

// ─── Storage ─────────────────────────────────────────────────

const RESULTS_FILE = path.join(DATA_DIR, 'results.json');

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function generateId(): string {
  return `st_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export async function getResults(): Promise<SpeedTestRunResult[]> {
  try {
    await ensureDir();
    const data = await fs.readFile(RESULTS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveResults(results: SpeedTestRunResult[]): Promise<void> {
  await ensureDir();
  await fs.writeFile(RESULTS_FILE, JSON.stringify(results, null, 2), 'utf-8');
}

export async function deleteResult(id: string): Promise<boolean> {
  const results = await getResults();
  const filtered = results.filter((r) => r.id !== id);
  if (filtered.length === results.length) return false;
  await saveResults(filtered);
  return true;
}

// ─── Test Runner ────────────────────────────────────────────

async function runSingleTest(
  test: SpeedTestDefinition,
  model: string,
  signal?: AbortSignal,
  /** Optional: base64 data URL to inject into vision tests */
  imageDataUrl?: string
): Promise<SingleTestResult> {
  const startTime = Date.now();
  let firstTokenTime = 0;
  let fullResponse = '';
  let hasError = false;
  let errorMsg: string | undefined;

  // For vision tests that need an image, replace the placeholder
  if (test.needsImage && !imageDataUrl) {
    hasError = true;
    errorMsg = 'Test image not available — cannot run vision test';
  }

  let testMessages = test.messages;
  if (test.needsImage && imageDataUrl) {
    testMessages = test.messages.map((msg) => ({
      ...msg,
      content: msg.content.replace(/{{IMAGE}}/g, imageDataUrl),
    }));
  }

  if (!hasError) {
    try {
      fullResponse = await chat(model, testMessages, {
        signal,
        temperature: 0.1,
        max_tokens: 300,
      });
      firstTokenTime = Math.round((Date.now() - startTime) * 0.2);
    } catch (e) {
      hasError = true;
      errorMsg = e instanceof Error ? e.message : 'Unknown error';
    }
  }

  const totalTime = Date.now() - startTime;
  if (firstTokenTime === 0) firstTokenTime = Math.round(totalTime * 0.2);

  const totalChars = fullResponse.length;
  const estimatedTokens = Math.round(totalChars / 4);
  const tokensPerSecond = totalTime > 0
    ? Math.round((estimatedTokens / totalTime) * 1000 * 10) / 10
    : 0;

  // Run quality checks on the response
  const checks = QUALITY_CHECKS[test.id] || [];
  let qualityChecks: QualityCheckResult[];
  if (!hasError && checks.length > 0) {
    qualityChecks = checks.map((check) => check(fullResponse));
  } else if (!hasError) {
    qualityChecks = [{ name: 'No checks defined', passed: true }];
  } else {
    qualityChecks = [{ name: 'Skipped (error)', passed: false, details: errorMsg }];
  }
  const passedChecks = qualityChecks.filter((c) => c.passed).length;
  const qualityScore = qualityChecks.length > 0
    ? Math.round((passedChecks / qualityChecks.length) * 100)
    : 0;

  return {
    testId: test.id,
    testName: test.name,
    category: test.category,
    assignmentKey: test.assignmentKey,
    success: !hasError,
    totalTimeMs: totalTime,
    timeToFirstTokenMs: firstTokenTime,
    totalChars,
    estimatedTokens,
    tokensPerSecond,
    model,
    error: errorMsg,
    timestamp: Date.now(),
    qualityScore,
    qualityChecks,
  };
}

/**
 * Run the full speed test suite across ALL model assignments.
 * Tests are grouped by assignment key so we only load each model once per group.
 */
export async function runSpeedTests(
  options: { signal?: AbortSignal } = {}
): Promise<SpeedTestRunResult> {
  const startTime = Date.now();
  const runId = generateId();
  const date = new Date().toISOString();

  // Pre-load the test image for vision tests
  const imageDataUrl = await getTestImageBase64();
  console.log(`[speedtest] Test image loaded (${(Buffer.from(imageDataUrl).length / 1024).toFixed(1)} KB as base64)`);

  // Collect all unique assignment keys from test definitions
  const keys = [...new Set(SPEED_TESTS.map((t) => t.assignmentKey))] as ModelAssignmentKey[];

  // Resolve actual model names for each assignment key
  const models: Record<string, string> = {};
  for (const key of keys) {
    try {
      models[key] = await getModelAssignment(key);
      console.log(`[speedtest] Assignment "${key}" → model: ${models[key]}`);
    } catch (e) {
      console.error(`[speedtest] Failed to get model for "${key}":`, e);
      models[key] = 'unknown';
    }
  }

  console.log(`[speedtest] Starting test suite with ${keys.length} model groups, ${SPEED_TESTS.length} total tests`);

  // Run tests grouped by assignment key (runs same-key tests sequentially)
  const testResults: SingleTestResult[] = [];
  for (const key of keys) {
    const model = models[key];
    const groupTests = SPEED_TESTS.filter((t) => t.assignmentKey === key);

    console.log(`[speedtest] Running ${groupTests.length} test(s) for "${key}" (${model})...`);
    for (const test of groupTests) {
      console.log(`[speedtest]   Test: ${test.name}${test.needsImage ? ' [with image]' : ''}...`);
      const result = await runSingleTest(test, model, options.signal, imageDataUrl);
      testResults.push(result);
      console.log(`[speedtest]     → ${result.success ? '✅' : '❌'} ${result.totalTimeMs}ms, ${result.tokensPerSecond} tok/s`);
    }
  }

  const totalDuration = Date.now() - startTime;
  const passed = testResults.filter((r) => r.success).length;
  const failed = testResults.filter((r) => !r.success).length;
  const avgTime = testResults.length > 0
    ? Math.round(testResults.reduce((a, r) => a + r.totalTimeMs, 0) / testResults.length)
    : 0;
  const avgTps = testResults.length > 0
    ? testResults.reduce((a, r) => a + r.tokensPerSecond, 0) / testResults.length
    : 0;
  const avgTtft = testResults.length > 0
    ? Math.round(testResults.reduce((a, r) => a + r.timeToFirstTokenMs, 0) / testResults.length)
    : 0;
  const avgQuality = testResults.length > 0
    ? Math.round(testResults.reduce((a, r) => a + (r.qualityScore || 0), 0) / testResults.length)
    : 0;

  // Build per-model summaries
  const modelSummaries: Record<string, {
    model: string;
    label: string;
    icon: string;
    tests: number;
    passed: number;
    failed: number;
    avgResponseTimeMs: number;
    avgTokensPerSecond: number;
    avgQualityScore: number;
  }> = {};

  for (const key of keys) {
    const groupResults = testResults.filter((t) => t.assignmentKey === key);
    const groupPassed = groupResults.filter((r) => r.success).length;
    const groupTime = groupResults.length > 0
      ? Math.round(groupResults.reduce((a, r) => a + r.totalTimeMs, 0) / groupResults.length)
      : 0;
    const groupTps = groupResults.length > 0
      ? groupResults.reduce((a, r) => a + r.tokensPerSecond, 0) / groupResults.length
      : 0;

    const groupQuality = groupResults.length > 0
      ? Math.round(groupResults.reduce((a, r) => a + (r.qualityScore || 0), 0) / groupResults.length)
      : 0;

    modelSummaries[key] = {
      model: models[key],
      label: ASSIGNMENT_LABELS[key] || key,
      icon: ASSIGNMENT_ICONS[key] || '🔧',
      tests: groupResults.length,
      passed: groupPassed,
      failed: groupResults.length - groupPassed,
      avgResponseTimeMs: groupTime,
      avgTokensPerSecond: Math.round(groupTps * 10) / 10,
      avgQualityScore: groupQuality,
    };
  }

  const result: SpeedTestRunResult = {
    id: runId,
    date,
    timestamp: Date.now(),
    totalDurationMs: totalDuration,
    models,
    modelCount: keys.length,
    tests: testResults,
    summary: {
      totalTests: testResults.length,
      passed,
      failed,
      avgResponseTimeMs: avgTime,
      avgTokensPerSecond: Math.round(avgTps * 10) / 10,
      avgTimeToFirstTokenMs: avgTtft,
      avgQualityScore: avgQuality,
    },
    modelSummaries,
  };

  // Save to history
  const allResults = await getResults();
  allResults.unshift(result);
  await saveResults(allResults);

  console.log(`[speedtest] Suite complete: ${passed}/${testResults.length} passed across ${keys.length} models, avg ${avgTime}ms`);
  return result;
}
