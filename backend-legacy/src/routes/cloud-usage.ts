import { Hono } from 'hono';
import { promises as fs } from 'fs';
import path from 'path';
import { getDataDir } from '../utils/helpers';

const USAGE_FILE = path.join(getDataDir(), 'cloud_usage.json');

// ─── Model Pricing Table (USD per 1M tokens) ──────────────────────
// Covers the most common cloud models. Users can override via custom pricing.
const DEFAULT_PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-4o':            { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':       { input: 0.15,  output: 0.60 },
  'gpt-4-turbo':       { input: 10.00, output: 30.00 },
  'gpt-4':             { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo':     { input: 0.50,  output: 1.50 },
  'o1':                { input: 15.00, output: 60.00 },
  'o1-mini':           { input: 3.00,  output: 12.00 },
  'o3-mini':           { input: 1.10,  output: 4.40 },
  // Anthropic
  'claude-sonnet-4-20250514':  { input: 3.00,  output: 15.00 },
  'claude-3-5-sonnet-20241022':{ input: 3.00,  output: 15.00 },
  'claude-3-5-haiku-20241022': { input: 0.80,  output: 4.00 },
  'claude-3-opus-20240229':    { input: 15.00, output: 75.00 },
  'claude-3-haiku-20240307':   { input: 0.25,  output: 1.25 },
  // Google
  'gemini-2.0-flash':          { input: 0.10,  output: 0.40 },
  'gemini-1.5-pro':            { input: 1.25,  output: 5.00 },
  'gemini-1.5-flash':          { input: 0.075, output: 0.30 },
  // DeepSeek
  'deepseek-chat':      { input: 0.14,  output: 0.28 },
  'deepseek-coder':     { input: 0.14,  output: 0.28 },
  'deepseek-reasoner':  { input: 0.55,  output: 2.19 },
};

interface CloudUsage {
  /** Total cloud API requests made since last reset */
  totalRequests: number;
  /** Estimated total tokens consumed */
  totalTokens: number;
  /** Requests per model */
  byModel: Record<string, number>;
  /** Per-model token tracking: { model: { input, output } } */
  tokensByModel: Record<string, { input: number; output: number }>;
  /** Monthly limit (number of requests) — 0 = unlimited */
  monthlyLimit: number;
  /** Token budget — 0 = unlimited */
  tokenBudget: number;
  /** Custom pricing overrides: { model: { input, output } } per 1M tokens */
  customPricing: Record<string, { input: number; output: number }>;
  /** ISO date of last reset */
  lastReset: string;
  /** ISO date of current tracking period start (month boundary) */
  periodStart: string;
}

interface CostBreakdown {
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

const DEFAULT_USAGE: CloudUsage = {
  totalRequests: 0,
  totalTokens: 0,
  byModel: {},
  tokensByModel: {},
  monthlyLimit: 0,
  tokenBudget: 0,
  customPricing: {},
  lastReset: new Date().toISOString(),
  periodStart: getMonthStart(),
};

function getMonthStart(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

function isNewMonth(usage: CloudUsage): boolean {
  return usage.periodStart !== getMonthStart();
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(getDataDir(), { recursive: true });
}

async function loadUsage(): Promise<CloudUsage> {
  try {
    await ensureDir();
    const data = await fs.readFile(USAGE_FILE, 'utf-8');
    const parsed = JSON.parse(data) as CloudUsage;
    // Auto-reset if a new month started
    if (isNewMonth(parsed)) {
      parsed.totalRequests = 0;
      parsed.totalTokens = 0;
      parsed.byModel = {};
      parsed.tokensByModel = {};
      parsed.periodStart = getMonthStart();
      parsed.lastReset = new Date().toISOString();
      await saveUsage(parsed);
    }
    return { ...DEFAULT_USAGE, ...parsed };
  } catch {
    return DEFAULT_USAGE;
  }
}

async function saveUsage(usage: CloudUsage): Promise<void> {
  await ensureDir();
  await fs.writeFile(USAGE_FILE, JSON.stringify(usage, null, 2));
}

/**
 * Get pricing for a model — custom overrides take priority, then fuzzy match
 * against the default table (prefix match for provider-prefixed model names).
 */
function getModelPricing(
  model: string,
  customPricing: Record<string, { input: number; output: number }>
): { input: number; output: number } | null {
  // 1. Exact custom override
  if (customPricing[model]) return customPricing[model];
  // 2. Exact default
  if (DEFAULT_PRICING[model]) return DEFAULT_PRICING[model];
  // 3. Fuzzy: model contains a known key (e.g. "openai/gpt-4o" → "gpt-4o")
  const lower = model.toLowerCase();
  for (const [key, price] of Object.entries(DEFAULT_PRICING)) {
    if (lower.includes(key)) return price;
  }
  // 4. Custom pricing prefix match
  for (const [key, price] of Object.entries(customPricing)) {
    if (lower.includes(key.toLowerCase())) return price;
  }
  return null;
}

/**
 * Calculate estimated cost for a model given input/output token counts.
 */
function calculateModelCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  customPricing: Record<string, { input: number; output: number }>
): number {
  const pricing = getModelPricing(model, customPricing);
  if (!pricing) return 0;
  // Pricing is per 1M tokens
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

const cloudUsage = new Hono();

// GET / — read current usage with cost breakdown
cloudUsage.get('/', async (c) => {
  const usage = await loadUsage();

  // Build cost breakdown per model
  const breakdown: CostBreakdown[] = [];
  let totalEstimatedCost = 0;

  for (const [model, tokens] of Object.entries(usage.tokensByModel)) {
    const inputTokens = tokens.input || 0;
    const outputTokens = tokens.output || 0;
    const pricing = getModelPricing(model, usage.customPricing);

    let inputCost = 0;
    let outputCost = 0;
    if (pricing) {
      inputCost = (inputTokens / 1_000_000) * pricing.input;
      outputCost = (outputTokens / 1_000_000) * pricing.output;
    }
    const totalCost = inputCost + outputCost;
    totalEstimatedCost += totalCost;

    breakdown.push({
      model,
      inputTokens,
      outputTokens,
      inputCost,
      outputCost,
      totalCost,
    });
  }

  // Sort breakdown by cost descending
  breakdown.sort((a, b) => b.totalCost - a.totalCost);

  // Pricing info for known models
  const pricingTable: Record<string, { input: number; output: number; source: string }> = {};
  for (const [model, price] of Object.entries(DEFAULT_PRICING)) {
    pricingTable[model] = { ...price, source: 'built-in' };
  }
  for (const [model, price] of Object.entries(usage.customPricing)) {
    pricingTable[model] = { ...price, source: 'custom' };
  }

  return c.json({
    ...usage,
    costBreakdown: breakdown,
    totalEstimatedCost,
    pricingTable,
  });
});

// POST /increment — called by the pipeline when a cloud request is made
cloudUsage.post('/increment', async (c) => {
  try {
    const body = await c.req.json();
    const { model, tokens, inputTokens, outputTokens } = body as {
      model?: string;
      tokens?: number;
      inputTokens?: number;
      outputTokens?: number;
    };
    const usage = await loadUsage();
    usage.totalRequests += 1;

    // Token tracking (legacy flat total)
    const tokenDelta = tokens || 0;
    usage.totalTokens += tokenDelta;

    // Per-model request count
    if (model) {
      usage.byModel[model] = (usage.byModel[model] || 0) + 1;

      // Per-model token tracking (input/output split)
      if (!usage.tokensByModel) usage.tokensByModel = {};
      if (!usage.tokensByModel[model]) usage.tokensByModel[model] = { input: 0, output: 0 };

      if (inputTokens !== undefined || outputTokens !== undefined) {
        // Split tokens provided
        usage.tokensByModel[model].input += inputTokens || 0;
        usage.tokensByModel[model].output += outputTokens || 0;
      } else if (tokenDelta > 0) {
        // Legacy: approximate 60/40 input/output split
        usage.tokensByModel[model].input += Math.round(tokenDelta * 0.6);
        usage.tokensByModel[model].output += Math.round(tokenDelta * 0.4);
      }
    }

    await saveUsage(usage);
    return c.json(usage);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed to increment' }, 500);
  }
});

// PUT /limit — update the monthly request limit and token budget
cloudUsage.put('/limit', async (c) => {
  try {
    const body = await c.req.json();
    const usage = await loadUsage();
    if (body.monthlyLimit !== undefined) usage.monthlyLimit = Number(body.monthlyLimit) || 0;
    if (body.tokenBudget !== undefined) usage.tokenBudget = Number(body.tokenBudget) || 0;
    await saveUsage(usage);
    return c.json(usage);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed to update limit' }, 500);
  }
});

// PUT /pricing — update custom pricing overrides
cloudUsage.put('/pricing', async (c) => {
  try {
    const body = await c.req.json();
    const { model, input, output } = body as { model?: string; input?: number; output?: number };
    if (!model) return c.json({ error: 'model is required' }, 400);
    const usage = await loadUsage();
    if (!usage.customPricing) usage.customPricing = {};
    if (input !== undefined && output !== undefined) {
      usage.customPricing[model] = { input, output };
    } else {
      // Remove custom pricing (revert to built-in)
      delete usage.customPricing[model];
    }
    await saveUsage(usage);
    return c.json({ customPricing: usage.customPricing });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed to update pricing' }, 500);
  }
});

// POST /reset — reset counters (keep limits and custom pricing)
cloudUsage.post('/reset', async (c) => {
  const usage = await loadUsage();
  usage.totalRequests = 0;
  usage.totalTokens = 0;
  usage.byModel = {};
  usage.tokensByModel = {};
  usage.lastReset = new Date().toISOString();
  usage.periodStart = getMonthStart();
  await saveUsage(usage);
  return c.json(usage);
});

export default cloudUsage;
