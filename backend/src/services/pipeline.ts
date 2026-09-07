import { promises as fs } from 'fs';
import path from 'path';
import { streamChat, streamChatWithTools, modelSupportsThinking } from './ollama';
import type { ToolLoopMessage } from './ollama';
import { getMemory } from './memory';
import { getResolvedModel, getModelAssignment } from './model-assignments';
import { getWebContext } from './search';
import { executeTool, detectTool, getAllTools, isProbablyMathExpression } from './tools/index';
import type { ToolResult } from './tools/index';
import { runAgentLoop, collectReferencedFiles } from './agent';
import { sanitizeSvg, saveArtwork } from './image-gen';
import { withAiRules } from './ai-rules';
import { findDangerousRequest, DANGEROUS_REPLY } from './content-guard';
import { getCloudSettings } from '../routes/settings';
import type { ConversationMode, Message } from '../types';

// ─── Cloud routing state (resolved once per pipeline run) ────────
let _cloudEndpoint = '';
let _cloudApiKey = '';

/**
 * Rough token estimate: ~4 characters per token for English text.
 * Used when the actual token count isn't available from the API.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Increment cloud usage counter (fire-and-forget, never blocks the pipeline) */
async function trackCloudUsage(modelName: string, inputTokens?: number, outputTokens?: number): Promise<void> {
  try {
    const totalTokens = (inputTokens || 0) + (outputTokens || 0);
    const res = await fetch('http://localhost:' + (process.env.PORT || 3001) + '/api/cloud-usage/increment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': 'settings_auth=1' },
      body: JSON.stringify({
        model: modelName,
        tokens: totalTokens,
        inputTokens: inputTokens || 0,
        outputTokens: outputTokens || 0,
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const usage = await res.json();
      // Log warning when approaching limit
      if (usage.monthlyLimit > 0 && usage.totalRequests >= usage.monthlyLimit * 0.9) {
        console.warn(`[cloud-usage] Approaching monthly limit: ${usage.totalRequests}/${usage.monthlyLimit}`);
      }
    }
  } catch {
    // Usage tracking is best-effort — never break the pipeline
  }
}

interface PipelineOptions {
  model: string;
  messages: Message[];
  mode?: ConversationMode;
  workspacePath?: string;
  signal?: AbortSignal;
  onStage: (stage: string) => void;
  onChunk: (chunk: string) => void;
  /** @deprecated use thinkingMode — kept for backward compatibility */
  thinkingEnabled?: boolean;
  /** 'auto' (default): think only when the message needs reasoning. 'off': never. */
  thinkingMode?: 'auto' | 'off';
  userId?: string;
  userName?: string;
  planningEnabled?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  /** Koding mode: whether the AI may write/delete files directly (tool loop) */
  autoApply?: boolean;
  /** Koding mode: fired when the AI writes/deletes a file (for live UI updates) */
  onFileWritten?: (write: { path: string; changeType: string; originalContent?: string }) => void;
  /** Koding mode: fired when the AI starts a tool call */
  onAgentTool?: (call: { tool: string; args: Record<string, unknown> }) => void;
  /** Phase 3: fired when the agent wants to execute a mutating tool and needs approval */
  onApprovalRequest?: (key: string, tool: string, args: Record<string, unknown>) => void;
  /** Phase 3: permission level for tool execution */
  toolPermission?: 'auto' | 'read-only' | 'ask-each' | 'suggest' | 'auto-edit';
  /** Fired with each reasoning chunk from thinking models (qwen3, deepseek-r1, etc.) */
  onThinking?: (chunk: string) => void;
  /** Koding mode: fired when the AI runs a shell command or auto-verify (terminal feed) */
  onAgentCommand?: (cmd: { command: string; output: string; failed: boolean }) => void;
  /** Koding mode: fired when the AI asks the user a clarifying question (ask_user) */
  onQuestion?: (key: string, question: string) => void;
  /** Koding mode: fired when a run is stopped/capped so the caller can persist resume state */
  onResumeState?: (state: { history: { role: string; content: string }[] }) => void;
  /** Koding mode: fired when the planning phase produces a plan */
  onPlan?: (plan: string) => void;
  /** Koding mode: resume a previously stopped run */
  resumeState?: { history: { role: string; content: string }[] };
  /** Koding mode: plan mode — 'off' = skip planning (fastest), 'on' = always plan, 'auto' = plan for complex tasks only */
  planMode?: 'off' | 'on' | 'auto';
  /** Routing key for ask_user answers (usually the conversation id) */
  conversationId?: string;
  /** Fired once with the model that generated the final response */
  onModelInfo?: (model: string, source: 'local' | 'cloud') => void;
}

interface DetectedIntent {
  hasImage: boolean;
  wantsCode: boolean;
  wantsFileInfo: boolean;
  wantsTool: boolean;
  toolId?: string;
  toolParams?: Record<string, unknown>;
  imageDataUrl?: string;
}

// IGNORE_DIRS from files route — skip these when listing for the AI
const LIST_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.DS_Store',
  '__pycache__', '.next', '.nuxt', 'dist', 'build', '.cache',
  'target', 'vendor', '.venv', 'venv', 'env',
  // Server internals — the agent must never see or touch these (workspace = app repo).
  'backend', '.freebuff', 'certs', 'server-gui', 'release',
]);

/**
 * Smart heuristic to decide whether a user message actually needs a web search.
 * Skips greetings, acknowledgments, very short messages, and conversational follow-ups
 * that are clearly not asking for external/factual information.
 */
function needsWebSearch(userMessage: string): boolean {
  const trimmed = userMessage.trim();
  if (!trimmed || trimmed.length < 15) return false;

  const lower = trimmed.toLowerCase();

  // Skip pure short acknowledgments and pleasantries
  const shortAcknowledgments = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|yeah|sure|great|nice|cool|good|lol|haha|awesome|perfect|got it|i see|understood|makes sense|indeed|right|of course|bye|goodbye)$/i;
  if (shortAcknowledgments.test(lower)) return false;

  // Skip conversational follow-ups that don't need external info
  const conversationalFollowUps = /(tell me more|continue|go on|what else|can you elaborate|can you explain further|that makes sense|good point|i agree|you('| a)re right|fair enough)/i;
  if (conversationalFollowUps.test(lower)) return false;

  // Skip personal / self-referential questions. The user is asking about
  // THEMSELVES — their body, looks, life, or the AI's opinion of them.
  // These never need a web search: the AI answers from its own judgment and
  // persona. Searching them both wastes time AND derails the answer, because
  // the search results get injected as "primary source of truth" — the
  // resulting answer then reads like a dry stats dump, or worse, a
  // safety-tuned search model's refusal text becomes the "answer".
  const selfReferential =
    /\bam i\b/i.test(lower) ||
    /\bdo you think\b.*\b(i'?m|i am|we|my|me)\b/i.test(lower) ||
    /\brate\b.*\b(my|me)\b/i.test(lower) ||
    /\bhow do i look\b/i.test(lower) ||
    /\bhow (?:big|small|long|tall|old|good|bad|attractive|pretty|handsome|smart) (?:am i|is my)\b/i.test(lower) ||
    /\bis my\b.*\b(big|small|long|tall|good|bad|attractive|pretty|handsome|smart|nice|ok|okay|normal|weird|fine)\b/i.test(lower);
  if (selfReferential) return false;

  // Explicit search requests — user is directly asking the AI to search.
  const explicitSearch = /\b(search|look\s*up|find\s*(?:me)?|google|look\s*into|research|check\s*(?:online|the\s*web|internet)|what(?:'s| is| are) (?:on|in|about|the latest)|tell me about)\b/i.test(lower);
  if (explicitSearch) return true;

  // Time-sensitive / external-factual queries.
  // General knowledge ("What is X", "How do I Y") the model already knows.
  const containsFactualNeed = /\b(current|latest|recent|news|update|today'?s|tonight|tomorrow|yesterday|population|weather|price|cost|distance|temperature|forecast|schedule|deadline|release|announcement|election|president|ceo|founder|invented|discovered|stock|rate|gdp|salary|rank|record|statistic|index|benchmark)\b/i.test(lower);
  const hasTimeWord = /\b(now|right now|currently|as of|in \d{4}|this (?:year|month|week|day)|last (?:year|month|week))\b/i.test(lower);

  return containsFactualNeed || hasTimeWord;
}

/**
 * Adaptive thinking: decide whether a single message actually benefits from
 * reasoning (thinking mode). Simple chit-chat and quick recall do NOT — math,
 * logic, multi-step problems, comparisons and causal "why/how" questions do.
 * This keeps thinking off for things that don't need it (faster, and small
 * models often answer worse when forced to reason unnecessarily).
 */
export function needsThinking(userMessage: string): boolean {
  const text = (userMessage || '').replace(/\[image:[^\]]+\]/g, '').trim();
  if (!text || text.length < 4) return false;
  const lower = text.toLowerCase();

  // Pure acknowledgments / pleasantries — never think.
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|yeah|nope|sure|great|cool|good|lol|haha|awesome|perfect|nice|bye|goodbye|alright|got it|understood|makes sense|thanks a lot)$/i.test(lower)) {
    return false;
  }

  // Math: math vocabulary, or the message is (mostly) a bare math expression.
  // A range like "scale 1-10" inside a sentence is NOT math.
  const hasMathVocab =
    /\b(calculate|compute|solve|equation|algebra|geometry|probability|statistics?|percentage|fraction|derivative|integral)\b/.test(lower);
  const exprCandidate = text.replace(/^(calculate|what (?:is|'s)|compute|solve|evaluate)\s+/i, '').trim();
  if (hasMathVocab || isProbablyMathExpression(exprCandidate)) return true;

  // Reasoning vocabulary — analysis, comparison, causality, judgment.
  const reasoningVocab =
    /\b(analy[sz]e|compare|contrast|explain why|prove|deduce|derive|predict|justify|logic|puzzle|hypothes|evaluate|interpret|implications|consequences|trade-offs?|pros and cons|should (i|you|we)|is it (better|worse|ethical|fair|correct)|what would happen|how (would|can|should)|why (is|are|does|do|would|should))\b/;
  if (reasoningVocab.test(lower)) return true;

  // "which X is better/worse/best" — a judgment/comparison question.
  if (/\bwhich\b.*\b(better|worse|best|cheaper|faster|stronger|more reliable)\b/i.test(text)) return true;

  // Multiple questions in one message = multi-step reasoning.
  const questionCount = (text.match(/\?/g) || []).length;
  if (questionCount >= 2) return true;

  // Long, involved questions with at least one question mark.
  if (text.length > 100 && questionCount >= 1) return true;

  return false;
}

async function listWorkspaceFiles(wsPath: string): Promise<string> {
  try {
    const resolved = path.resolve(wsPath);
    await fs.access(resolved);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) return '';

    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const filtered = entries.filter((e) => !e.name.startsWith('.') && !LIST_IGNORE_DIRS.has(e.name));

    // Build a formatted tree
    const lines: string[] = [];
    for (const entry of filtered) {
      if (entry.isDirectory()) {
        lines.push(`  📁 ${entry.name}/`);
      } else {
        let size = '';
        try {
          const s = await fs.stat(path.join(resolved, entry.name));
          size = s.size < 1024 ? ` (${s.size}B)` : ` (${(s.size / 1024).toFixed(1)}KB)`;
        } catch { /* skip */ }
        lines.push(`  📄 ${entry.name}${size}`);
      }
    }

    if (lines.length === 0) return '  (empty directory)';
    return lines.join('\n');
  } catch {
    return '';
  }
}

async function detectIntent(messages: Message[], mode?: ConversationMode): Promise<DetectedIntent> {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') {
    return { hasImage: false, wantsCode: false, wantsFileInfo: false, wantsTool: false };
  }

  const content = last.content.toLowerCase();
  const hasImage = content.includes('[image:data:image');

  // Detect if user wants to use a tool (async — uses dynamic import)
  const toolMatch = await detectTool(last.content);
  const wantsTool = !!toolMatch;
  const toolId = toolMatch?.toolId;
  const toolParams = toolMatch?.params;

  // Detect if user is asking about files/directory contents
  const fileQueryPhrases = [
    'what files', 'list files', 'show files', 'tell me what files',
    'what is in', 'what is inside', 'what\'s in', 'what\'s inside',
    'files in this directory', 'files in this folder',
    'list directory', 'show directory', 'directory contents',
    'how many files', 'what do you see', 'what do you have',
    'files are there', 'files are here', 'files exist',
    'show me the files', 'tell me the files',
  ];
  const wantsFileInfo = fileQueryPhrases.some((phrase) => content.includes(phrase));

  // Broader code-related phrases for Koding mode (catches more requests).
  // These are multi-word requests or strong code signals — NOT bare generic
  // words like "app" or "file", so conversational messages like "tell me
  // about yourself" or "what do you think of this design?" do NOT trigger
  // the heavy code pipeline.
  const agentCodePhrases = [
    'write a', 'write an', 'write the', 'write code', 'write a function',
    'write a script', 'write a program', 'write a component', 'write a file',
    'generate a', 'generate an', 'generate code', 'generate a function',
    'generate a component', 'create a', 'create an', 'create code',
    'create a function', 'create a script', 'create a component',
    'create a file', 'create a page', 'build a', 'build an',
    'build a website', 'build an app', 'build a page', 'build a component',
    'build a project', 'make a', 'make an', 'make a website',
    'make an app', 'make a page', 'make a component', 'make a file',
    'implement a', 'implement an', 'implement this', 'implement the',
    'add a', 'add an', 'add the', 'add code', 'add a function',
    'add a component', 'add a file', 'add a button', 'add a page',
    'update the', 'update my', 'edit the', 'edit my', 'change the',
    'modify the', 'fix the', 'fix this', 'fix my', 'fix a bug', 'debug',
    'refactor', 'rewrite', 'convert to', 'convert this', 'turn this into',
    'turn it into', 'remake this', 'recreate this', 'code this',
    'html page', 'css code', 'web page', 'website',
    'in html', 'in css', 'in javascript', 'in python', 'in typescript',
    'in react', 'in vue', 'in go', 'in rust', 'in java',
    'the code', 'my code', 'this code', 'some code', 'a function',
    'a script', 'a component', 'a class', 'a file', 'a page', 'a button',
    'a modal', 'a form', 'a menu', 'a header', 'a footer', 'a navbar',
    'a database', 'an api', 'a style', 'a layout', 'a template',
    'typescript', 'javascript', 'python', 'react', 'vue', 'html', 'css', 'sql',
  ];

  // Fallback for terse agent-mode commands ("add dark mode", "build todo app").
  // If the message contains a code VERB and a code NOUN anywhere, treat it as
  // a code request — without requiring articles like "add a".
  const codeVerbs = [
    'add', 'create', 'build', 'make', 'write', 'generate', 'fix', 'update',
    'remove', 'delete', 'implement', 'change', 'modify', 'convert', 'turn',
    'refactor', 'rewrite', 'style', 'code', 'debug', 'edit',
  ];
  const codeNouns = [
    'app', 'website', 'web', 'page', 'button', 'form', 'component',
    'function', 'file', 'style', 'theme', 'layout', 'header', 'footer',
    'modal', 'menu', 'navbar', 'nav', 'database', 'api', 'ui', 'interface',
    'template', 'script', 'program', 'project', 'class', 'todo', 'dark mode',
  ];
  const hasVerb = codeVerbs.some((v) => content.includes(v));
  const hasNoun = codeNouns.some((n) => content.includes(n));

  // Only trigger code stage on explicit code requests
  const codePhrases = [
    'write code', 'write a function', 'write a script', 'write a program',
    'generate code', 'create a function', 'create a script',
    'build a website', 'build an app', 'build a page',
    'code this', 'implement this', 'remake this', 'recreate this',
    'convert to html', 'convert to css', 'convert to javascript',
    'turn this into code', 'turn this into html', 'turn this into a website',
    'make this into', 'make it into', 'in html', 'in css', 'in javascript',
    'in python', 'in typescript', 'in react', 'in vue',
    'show me the code', 'give me the code', 'html page', 'css code',
  ];

  let wantsCode: boolean;
  if (mode === 'agent') {
    // Koding mode: phrase-based detection only — there is NO blanket
    // "message is long enough → run the code pipeline" rule. A 4+ word
    // conversational message ("how are you doing today?", "tell me about
    // yourself") stays in simple chat; the code pipeline only runs when the
    // message actually asks for code/files. The verb+noun fallback catches
    // terse commands like "add dark mode" or "build todo app" that skip
    // articles.
    wantsCode = agentCodePhrases.some((phrase) => content.includes(phrase)) ||
      (hasVerb && hasNoun);
  } else {
    wantsCode = codePhrases.some((phrase) => content.includes(phrase));
  }

  let imageDataUrl: string | undefined;
  const match = last.content.match(/\[image:(data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+))\]/);
  if (match) imageDataUrl = match[1];

  return { hasImage, wantsCode, wantsFileInfo, wantsTool, toolId, toolParams, imageDataUrl };
}

// Internal stage: runs the model without streaming output to user
async function runInternalStage(
  stageName: string,
  model: string,
  messages: Message[],
  think: boolean,
  signal?: AbortSignal,
  extraOpts: { temperature?: number; top_p?: number; max_tokens?: number } = {},
  onThinking?: (chunk: string) => void,
  onStage?: (stage: string) => void
): Promise<string> {
  console.log(`[pipeline] Internal stage "${stageName}" — model: ${model}, think: ${think}`);
  let output = '';
  let firstChunk = false;
  // Show a "warming up" indicator for cloud models after 15s of silence
  let warmingTimer: ReturnType<typeof setTimeout> | undefined;
  if (_cloudEndpoint) {
    warmingTimer = setTimeout(() => {
      if (!firstChunk) {
        console.log(`[pipeline] Cloud model still warming up after 15s (${model})...`);
        onStage?.('cloud:warming');
      }
    }, 15_000);
  }
  try {
    await streamChat(
      model,
      messages,
      (chunk) => {
        if (!firstChunk) {
          firstChunk = true;
          if (warmingTimer) clearTimeout(warmingTimer);
        }
        output += chunk;
      },
      { signal, think, ...extraOpts, onThinking, baseUrl: _cloudEndpoint || undefined, apiKey: _cloudApiKey || undefined }
    );
  } catch (e) {
    if (warmingTimer) clearTimeout(warmingTimer);
    if (e instanceof Error && e.name === 'AbortError') {
      console.log(`[pipeline] Stage "${stageName}" aborted`);
      throw e;
    }
    throw e;
  }
  if (warmingTimer) clearTimeout(warmingTimer);
  console.log(`[pipeline] Stage "${stageName}" done. Length: ${output.length}`);
  return output;
}

// Visible stage: streams output to the user
async function runVisibleStage(
  stageName: string,
  model: string,
  messages: Message[],
  think: boolean,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
  extraOpts: { temperature?: number; top_p?: number; max_tokens?: number } = {},
  onThinking?: (chunk: string) => void
): Promise<string> {
  console.log(`[pipeline] Visible stage "${stageName}" — model: ${model}, think: ${think}`);
  let output = '';
  try {
    await streamChat(
      model,
      messages,
      (chunk) => {
        output += chunk;
        onChunk(chunk);
      },
      { signal, think, ...extraOpts, onThinking, baseUrl: _cloudEndpoint || undefined, apiKey: _cloudApiKey || undefined }
    );
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      console.log(`[pipeline] Stage "${stageName}" aborted`);
      throw e;
    }
    throw e;
  }
  console.log(`[pipeline] Stage "${stageName}" done. Length: ${output.length}`);
  return output;
}

/**
 * Detect programming language/framework from user text and search for documentation.
 * Only runs in Koding mode before code generation.
 */
// ─── Model-driven tool calling ────────────────────────────

const MAX_TOOL_ROUNDS = 4;

/**
 * Tool schemas for chat mode: web_search + draw_image (the model can look
 * things up and draw pictures, without the ~900-token full tool set).
 * Kept in sync with the registry definitions so descriptions don't drift.
 */
const CHAT_TOOL_IDS = new Set(['web_search', 'draw_image']);

function toChatTools(): Record<string, unknown>[] {
  return toOllamaTools().filter((t) => {
    const name = (t.function as { name?: string } | undefined)?.name;
    return !!name && CHAT_TOOL_IDS.has(name);
  });
}

/** Convert the registered tool definitions into Ollama's tool schema. */
function toOllamaTools(): Record<string, unknown>[] {
  return getAllTools().map((t) => {
    const required = t.params.filter((p) => p.required).map((p) => p.name);
    const schema: Record<string, unknown> = {
      type: 'function',
      function: {
        name: t.id,
        description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            t.params.map((p) => [p.name, { type: p.type, description: p.description }])
          ),
        },
      },
    };
    if (required.length) (schema.function as Record<string, unknown>).required = required;
    return schema;
  });
}

/**
 * Run a chat turn with the MODEL deciding when to call tools (Ollama tool_calls).
 * Executed tools get their results fed back to the model; a failed tool is just
 * another result, so the model can answer naturally instead of the raw error
 * becoming the user-visible answer. Stops when the model produces content with
 * no tool calls, or after MAX_TOOL_ROUNDS (then one final plain pass).
 */
async function runChatToolLoop(
  stageName: string,
  model: string,
  messages: Message[],
  think: boolean,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
  extraOpts: { temperature?: number; top_p?: number; max_tokens?: number } = {},
  onThinking?: (chunk: string) => void,
  onStage?: (stage: string) => void,
  toolsOverride?: Record<string, unknown>[]
): Promise<string> {
  const tools = toolsOverride ?? toOllamaTools();
  const loopMessages: ToolLoopMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const userInput = lastUserMsg?.content ?? '';

  // Files produced by successful draw_image calls. The model is told to embed
  // them, but this deterministic fallback guarantees the image always shows up.
  const savedImages: string[] = [];
  const wantsImage = detectImageRequest(userInput);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Surface an explicit "image generation" stage so the UI can show a
    // dedicated generating-image box from the moment the model starts drawing.
    onStage?.(round === 0
      ? (wantsImage ? 'image:generating' : 'chat:thinking')
      : (savedImages.length ? 'image:generating' : 'tool:executing'));
    console.log(`[pipeline] Tool round ${round + 1}/${MAX_TOOL_ROUNDS} — ${model}`);
    const { content, toolCalls } = await streamChatWithTools(model, loopMessages, tools, onChunk, {
      signal,
      think,
      ...extraOpts,
      onThinking,
    });

    if (!toolCalls.length) return embedGeneratedImages(content, savedImages, onChunk);

    // Record what the model wanted to do, then feed the results back.
    loopMessages.push({ role: 'assistant', content, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const name = tc.function?.name ?? 'unknown';
      const args = tc.function?.arguments ?? {};
      let result: ToolResult;
      try {
        if (name === 'draw_image') onStage?.('image:generating');
        result = await executeTool(name, args, { userInput });
      } catch (e) {
        result = { success: false, output: `Tool "${name}" crashed: ${e instanceof Error ? e.message : String(e)}` };
      }
      console.log(`[pipeline] Tool "${name}" → ${result.success ? 'ok' : 'error'}: ${result.output.substring(0, 80)}`);
      if (name === 'draw_image' && result.success && result.data?.filename) {
        const filename = String(result.data.filename);
        if (filename) savedImages.push(filename);
      }
      loopMessages.push({ role: 'tool', content: result.output });
    }
  }

  // Cap reached — one final pass without tools so the user still gets an answer.
  console.log(`[pipeline] Tool loop cap (${MAX_TOOL_ROUNDS}) reached — final plain pass`);
  const final = await streamChatWithTools(model, loopMessages, [], onChunk, {
    signal,
    think,
    ...extraOpts,
    onThinking,
  });
  return embedGeneratedImages(final.content, savedImages, onChunk);
}

/**
 * Guarantee every successfully drawn image is referenced in the final reply.
 * If the model already embedded it (normal case) nothing changes; otherwise the
 * markdown is appended and streamed so the client's text matches what's saved.
 */
function embedGeneratedImages(content: string, filenames: string[], onChunk: (chunk: string) => void): string {
  let out = content;
  let appended = '';
  for (const filename of filenames) {
    const ref = `/api/generated/${filename}`;
    if (out.includes(ref)) continue; // model already embedded it
    const image = `![Generated image](${ref})`;
    appended += (out || appended ? '\n\n' : '') + image;
    out = out ? `${out}\n\n${image}` : image;
  }
  if (appended) onChunk(appended);
  return out;
}

// ─── Image request detection ─────────────────────────────────────
// The draw_image tool only fires when the model chooses to call it. Some
// models can't/won't use tools and instead reply "here's your image!" with no
// actual image — so when the user clearly asked for one, the pipeline also
// detects it and can author the SVG directly as a fallback.
const IMAGE_VERBS =
  'generate|draw|make|create|produce|paint|render|design|build|sketch|illustrate|imagine';
const IMAGE_NOUNS =
  'image|picture|photo|photograph|artwork|art|logo|icon|illustration|portrait|avatar|sketch|drawing|meme|wallpaper|banner|poster|mascot|character|cartoon';

function detectImageRequest(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase().replace(/\s+/g, ' ').trim();
  // Informational questions are never image requests.
  if (/\b(explain|describe|what is|what are|how (does|do|to|can i)|tell me about|why is|meaning of|difference between|tutorial)\b/.test(lower)) {
    return false;
  }
  // "generate/draw/create … an image/picture/logo …"
  if (new RegExp(`\\b(${IMAGE_VERBS})\\b[^.!?\\n]{0,100}\\b(${IMAGE_NOUNS})\\b`, 'i').test(lower)) {
    return true;
  }
  // "an image / a picture / a portrait of …" (no explicit verb, e.g. "an image of a cat")
  return new RegExp(`\\b(image|picture|photo|photograph|portrait|avatar)\\b[^.!?\\n]{0,60}\\bof (an?|the|my|our|a few|some)\\b`, 'i').test(lower);
}

/** Pull the raw <svg>…</svg> out of a model reply (tolerates markdown fences). */
function extractSvg(text: string): string {
  const start = text.indexOf('<svg');
  const end = text.lastIndexOf('</svg>');
  if (start === -1 || end === -1) return '';
  return text.slice(start, end + '</svg>'.length);
}

interface EnsureImageDrawnOptions {
  model: string;
  request: string;
  signal?: AbortSignal;
  onChunk: (chunk: string) => void;
  onStage?: (stage: string) => void;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

/**
 * Fallback used when the model never called draw_image: run one dedicated
 * no-tools call that returns ONLY an SVG for the request, then save it and
 * append the markdown image to the reply. If even that fails, the original
 * text reply is returned unchanged.
 */
async function ensureImageDrawn(baseText: string, o: EnsureImageDrawnOptions): Promise<string> {
  o.onStage?.('image:generating');
  const system =
    'You are a vector-art generator. Produce ONE complete standalone SVG document that draws the requested picture.\n' +
    'Rules:\n' +
    '- Output ONLY the raw SVG, starting with <svg and ending with </svg>. No markdown fences, no commentary, no extra words.\n' +
    '- Declare xmlns, width="1024", height="1024", viewBox="0 0 1024 1024".\n' +
    '- Flat vector style: rect, circle, ellipse, polygon, path and gradients inside <defs>; draw background first, foreground last.\n' +
    '- NEVER use <text> (no fonts available). Keep it under ~60 elements — a clean simple scene beats a busy one.';

  let content = '';
  try {
    const res = await streamChatWithTools(
      o.model,
      [
        { role: 'system', content: system },
        { role: 'user', content: o.request },
      ],
      [],
      (chunk) => { content += chunk; },
      {
        signal: o.signal,
        think: false,
        temperature: o.temperature,
        top_p: o.top_p,
        max_tokens: o.max_tokens,
      }
    );
    content = res.content || content;
  } catch (e) {
    console.warn('[pipeline] Image fallback call failed:', e instanceof Error ? e.message : String(e));
    return baseText;
  }

  const svg = extractSvg(content);
  const check = sanitizeSvg(svg);
  if (!check.ok) {
    console.warn(`[pipeline] Image fallback produced unusable SVG: ${check.error}`);
    return baseText;
  }

  try {
    const art = await saveArtwork(svg);
    const markdown = `![Generated image](/api/generated/${art.filename})`;
    console.log(`[pipeline] Image fallback saved ${art.filename}`);
    const appended = (baseText.trimEnd() ? '\n\n' : '') + markdown;
    o.onChunk(appended);
    return (baseText.trimEnd() ? baseText.trimEnd() + appended : markdown);
  } catch (e) {
    console.error('[pipeline] Image fallback save failed:', e);
    return baseText;
  }
}

interface RunDrawImageChatOptions {
  model: string;
  systemMessages: Message[];
  messages: Message[];
  requestText: string;
  think: boolean;
  signal?: AbortSignal;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  onChunk: (chunk: string) => void;
  onThinking?: (chunk: string) => void;
  onStage?: (stage: string) => void;
}

/**
 * Shared "the user asked for a picture" path — used by BOTH plain chat and
 * agent (Koding) mode so image requests behave identically everywhere:
 * nudge the model toward draw_image, then if the final reply still contains
 * no image, author the SVG directly with a dedicated no-tools call. An image
 * therefore always appears, no matter which model/view is being used.
 */
async function runDrawImageChat(o: RunDrawImageChatOptions): Promise<string> {
  const nudge =
    '\n\nThe user asked for an image. Call the draw_image tool, passing your complete SVG (read its description for the scene rules), then include the exact markdown image it returns in your reply.';
  const systemMessages = o.systemMessages.map((m, idx) =>
    idx === 0 ? { ...m, content: m.content + nudge } : m
  );
  const chatMessages: Message[] = [...systemMessages, ...o.messages];

  const reply = await runChatToolLoop(
    'chat',
    o.model,
    chatMessages,
    o.think,
    o.onChunk,
    o.signal,
    { temperature: o.temperature, top_p: o.top_p, max_tokens: o.max_tokens },
    o.onThinking,
    o.onStage,
    toChatTools()
  );

  // Some models answer "here's your image!" without ever calling draw_image.
  // If no image was embedded, author the SVG directly with a dedicated
  // no-tools call so the picture actually shows up.
  if (reply.includes('/api/generated/')) return reply;
  console.log('[pipeline] Model replied without draw_image — running SVG fallback');
  return ensureImageDrawn(reply, {
    model: o.model,
    request: o.requestText,
    signal: o.signal,
    onChunk: o.onChunk,
    onStage: o.onStage,
    temperature: o.temperature,
    top_p: o.top_p,
    max_tokens: o.max_tokens,
  });
}



/**
 * Build a memory context system message to inject personality/memory into the conversation.
 */
async function buildMemoryContext(userId?: string): Promise<string | null> {
  if (!userId) return null;
  try {
    const memory = await getMemory(userId);
    if (!memory.enabled || Object.keys(memory.categories).length === 0) return null;

    const lines: string[] = ['Here is what I know about you:'];
    for (const [category, entries] of Object.entries(memory.categories)) {
      lines.push(`\n# ${category}`);
      for (const [key, value] of Object.entries(entries)) {
        lines.push(`- ${key}: ${value}`);
      }
    }
    lines.push('\nUse this information naturally in our conversation. If I share updated info, update your knowledge.');
    return lines.join('\n');
  } catch {
    return null;
  }
}

export async function runPipeline(opts: PipelineOptions): Promise<string> {
  let model = opts.model;
  const { mode, workspacePath, signal, onStage, onChunk, userId, userName, planningEnabled, temperature, top_p, max_tokens, onThinking } = opts;
  let { messages } = opts;
  const intent = await detectIntent(messages, mode);

  // ─── Dangerous-content guard ──────────────────────────────
  // App-level safety net: refuse genuinely illegal/dangerous requests BEFORE
  // they reach the model. The check runs for every chat model — the app
  // enforces this line itself, independent of model behavior.
  const dangerousRequest = findDangerousRequest(messages);
  if (dangerousRequest) {
    console.log(`[pipeline] Blocked dangerous request (${dangerousRequest})`);
    onChunk?.(DANGEROUS_REPLY);
    return DANGEROUS_REPLY;
  }

  // ─── Cloud mode routing ──────────────────────────────────────
  // Resolve cloud endpoint once for all streamChat calls in this run.
  _cloudEndpoint = '';
  _cloudApiKey = '';
  try {
    const cloudSettings = await getCloudSettings();
    const { cloudMode, cloudApiKey, cloudEndpoint } = cloudSettings;
    console.log(`[pipeline] Cloud mode: ${cloudMode}, hasApiKey: ${!!cloudApiKey}`);

    if (cloudMode === 'cloud' && !cloudApiKey) {
      // Cloud-only mode but no API key — notify and fall back to local
      console.log('[cloud] Unavailable — no API key configured');
      onStage?.('cloud:unavailable');
      // Fall back: clear cloud settings so downstream uses local model
      _cloudEndpoint = '';
      _cloudApiKey = '';
    } else if (cloudMode !== 'local' && cloudApiKey && cloudEndpoint) {
      _cloudEndpoint = cloudEndpoint;
      _cloudApiKey = cloudApiKey;
      console.log(`[pipeline] Cloud routing enabled: ${cloudEndpoint}`);
    }

    // Resolve the main model through getResolvedModel so cloud models are
    // actually used when configured in cloud/auto mode.
    const resolvedChat = await getResolvedModel('chat');
    if (resolvedChat.source === 'cloud') {
      console.log(`[pipeline] Chat model resolved to cloud: ${resolvedChat.model}`);
    } else {
      console.log(`[pipeline] Chat model resolved to local: ${resolvedChat.model}`);
    }
    // Use the resolved model as the base for the pipeline
    model = resolvedChat.model;
    if (resolvedChat.source === 'cloud') {
      // Probe the cloud endpoint quickly to detect if it's reachable.
      // If unreachable, fall back to local so the user doesn't wait for
      // retries that will all fail.
      try {
        const probeController = new AbortController();
        const probeTimer = setTimeout(() => probeController.abort(), 5000);
        const probeRes = await fetch(cloudEndpoint + '/v1/models', {
          headers: { Authorization: `Bearer ${cloudApiKey}` },
          signal: probeController.signal,
        });
        clearTimeout(probeTimer);
        if (!probeRes.ok) throw new Error(`probe ${probeRes.status}`);
        // Cloud is reachable — use it
        const inputText = messages.map(m => m.content).join('\n');
        const inputTokenEst = estimateTokens(inputText);
        trackCloudUsage(resolvedChat.model, inputTokenEst);
      } catch (probeErr) {
        // Cloud unreachable — fall back to local model
        console.warn(`[pipeline] Cloud unreachable (${probeErr instanceof Error ? probeErr.message : String(probeErr)}) — falling back to local`);
        onStage?.('cloud:unavailable');
        _cloudEndpoint = '';
        _cloudApiKey = '';
        const localModel = await getModelAssignment('chat');
        console.log(`[pipeline] Fallback to local model: ${localModel}`);
        model = localModel;
      }
    }
  } catch (e) {
    console.error('[pipeline] Failed to resolve chat model:', e);
  }

  // ─── Adaptive thinking ────────────────────────────────────
  // 'off' never thinks; otherwise (default 'auto') decide per message whether
  // reasoning actually helps. When thinking IS needed but the base chat model
  // can't think, route to the dedicated Chat (Thinking) model instead.
  const thinkingMode: 'auto' | 'off' = opts.thinkingMode ?? (opts.thinkingEnabled === false ? 'off' : 'auto');
  const lastUserMsgForThink = [...messages].reverse().find((m) => m.role === 'user');
  // In agent (Koding) mode, always think if the model supports it — coding tasks
  // benefit from reasoning about approach before acting. For chat mode, use the
  // heuristic to decide if thinking adds value.
  const isAgentMode = mode === 'agent';
  const think = thinkingMode === 'off' ? false : (isAgentMode ? true : needsThinking(lastUserMsgForThink?.content ?? ''));
  console.log(`[pipeline] Thinking mode: ${thinkingMode}, agent: ${isAgentMode} → think: ${think}`);    if (think && !(await modelSupportsThinking(model))) {
    const resolved = await getResolvedModel('chat_thinking');
    if (resolved.model && resolved.model !== model) {
      console.log(`[pipeline] Auto-thinking: ${model} can't think → using ${resolved.model} (source: ${resolved.source})`);
      model = resolved.model;
    }
  }
  // Safety: if model is still pointing to a cloud model but cloud is unreachable,
  // force to local.
  if (model && _cloudEndpoint === '' && (await getResolvedModel('chat')).source === 'cloud') {
    const localModel = await getModelAssignment('chat');
    console.log(`[pipeline] Cloud cleared, forcing local: ${localModel}`);
    model = localModel;
  }

  // ─── Report final model to frontend ─────────────────────────
  // Tell the client which model is generating the response.
  try {
    const finalResolved = await getResolvedModel('chat');
    opts.onModelInfo?.(model, finalResolved.source);
  } catch {}

  // ─── IMAGE REQUESTS IN AGENT (KODING) MODE ────────────────
  // runAgentLoop is a coding loop: it happily replies "here's your picture!"
  // in plain text but never draws anything, so a draw request there produced
  // captions with no image. Route picture requests through the same guaranteed
  // chat draw pipeline (draw_image + dedicated SVG fallback) so an actual
  // image always appears — using the code model the Koding view expects.
  if (mode === 'agent' && !intent.hasImage) {
    const agentUserText = (lastUserMsgForThink?.content ?? '').replace(/\[image:[^\]]+\]/g, '').trim();
    if (agentUserText && detectImageRequest(agentUserText)) {
      console.log('[pipeline] Image request in agent mode — using draw pipeline instead of agent loop');
      const { model: codeModel } = await getResolvedModel('code');
      const drawModel = codeModel || model;
      const drawSystem = await withAiRules(
        'You are a friendly assistant generating an image for the user.\n' +
        'Warm and brief. If your draw_image tool call succeeded, include the markdown image it returned in your reply — it is important the user sees it.',
        'chat'
      );
      return await runDrawImageChat({
        model: drawModel,
        systemMessages: [{ role: 'system', content: drawSystem }],
        messages,
        requestText: agentUserText,
        think: false,
        signal,
        temperature,
        top_p,
        max_tokens,
        onChunk,
        onThinking,
        onStage,
      });
    }
  }

  // ─── AGENT LOOP (auto-apply mode) ─────────────────────────
  // In auto-apply mode the AI is autonomous: it can read files, run
  // commands, write and delete files, and iterate until the task is done.
  // Image/vision requests stay on the regular pipeline (they need the
  // vision-analysis and image-generation stages).
  if (mode === 'agent' && opts.autoApply === true && !intent.hasImage) {
    console.log('[pipeline] Koding mode with auto-apply — running autonomous loop');
    const memoryContext = await buildMemoryContext(userId);
    // Agent mode uses the CODE model for everything — tool calls, thinking,
    // responses. The code model is better at structured output (JSON tool calls)
    // and code generation than the chat model.
    const { model: agentModel } = await getResolvedModel('code');
    if (agentModel && agentModel !== model) {
      console.log(`[pipeline] Agent mode: using code model ${agentModel} instead of chat model ${model}`);
    }
    return await runAgentLoop({
      model: agentModel || model,
      messages,
      workspacePath,
      autoApply: true,
      userName,
      signal,
      think,
      askKey: opts.conversationId,
      resumeState: opts.resumeState,
      toolPermission: opts.toolPermission,
      cloudEndpoint: _cloudEndpoint || undefined,
      cloudApiKey: _cloudApiKey || undefined,
      planMode: opts.planMode,

      callbacks: {
        onStage,
        onChunk,
        onToolStart: opts.onAgentTool,
        onFileWritten: opts.onFileWritten,
        onThinking,
        onAgentCommand: opts.onAgentCommand,
        onQuestion: opts.onQuestion,
        onResumeState: opts.onResumeState,
        onApprovalRequest: opts.onApprovalRequest,
        onPlan: opts.onPlan,
      },
      temperature,
      top_p,
      max_tokens,
      extraContext: memoryContext || undefined,
    });
  }

  console.log(`[pipeline] Intent: hasImage=${intent.hasImage}, wantsCode=${intent.wantsCode}, wantsFileInfo=${intent.wantsFileInfo}, wantsTool=${intent.wantsTool}, think=${think}`);

  // ─── Message Truncation (#7) ──────────────────────────────
  // Keep only the last MAX_HISTORY messages + any system messages to limit context size.
  // This significantly speeds up model inference for long conversations.
  const MAX_HISTORY = 30;
  if (messages.length > MAX_HISTORY) {
    const originalLen = messages.length;
    const systemMsgs = messages.filter((m) => m.role === 'system');
    const recentMsgs = messages.slice(-MAX_HISTORY);
    messages = [...systemMsgs, ...recentMsgs] as typeof messages;
    console.log(`[pipeline] Truncated messages from ${originalLen} to ${messages.length} (max ${MAX_HISTORY})`);
  }

  // ─── Context Gathering (parallelized) ─────────────────────
  // Run file listing, memory loading, and web search in parallel.
  // Web search is smart-filtered to only run when the message actually needs external info.

  const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
  const userText = lastUserMsg
    ? lastUserMsg.content.replace(/\[image:[^\]]+\]/g, '').trim()
    : '';

  const needsFileListing = intent.wantsFileInfo || (intent.wantsCode && planningEnabled);
  const shouldSearch = !intent.hasImage && userText.length > 0 && needsWebSearch(userText);

  // Send immediate stage feedback so the user sees progress right away
  if (needsFileListing && workspacePath) onStage('reading:workspace');
  if (shouldSearch) onStage('search:web');

  // Kick off all independent context-gathering tasks in PARALLEL
  const [fileListing, memoryContext, webContext] = await Promise.all([
    needsFileListing && workspacePath ? listWorkspaceFiles(workspacePath).then(result => {
      console.log(`[pipeline] Workspace file listing: ${result.substring(0, 200)}...`);
      return result;
    }) : Promise.resolve(''),
    buildMemoryContext(userId),
    shouldSearch ? getWebContext(userText) : Promise.resolve(null),
  ]);

  // Log whether web search was skipped (useful for tuning the heuristic)
  if (userText && !shouldSearch && !intent.hasImage) {
    console.log(`[pipeline] Skipped web search (heuristic) for: "${userText.substring(0, 60)}..."`);
  }

  // Helper function to append memory and web context to system content
  const withContext = (content: string): string => {
    let result = content;
    if (memoryContext) result += '\n\n---\n\n' + memoryContext;
    if (webContext) {
      result += '\n\n---\n\n' +
        `[WEB SEARCH RESULTS — CURRENT AND LIVE]\n\nThe information below was retrieved from the internet in real-time through a web search. It is MORE CURRENT than my training data.\n\nINSTRUCTIONS TO ANSWER:\n- I MUST answer the user's question using THESE search results as my primary source of truth\n- I should answer DIRECTLY with the facts from these results — do NOT just provide links or tell the user to visit websites\n- If the results contain the answer, state it clearly and confidently in my response\n- Treat this information as accurate and current\n- Only mention website URLs if the user specifically asks for sources\n- If the results don't contain enough info to answer, say so honestly\n\nSearch results:\n${webContext}`;
    }
    return result;
  };

  // Tool output variables — declared here so both the TOOL STAGE and simple chat can use them
  let toolOutput: string | undefined;
  let toolStageHandled = false;
  let toolSucceeded = false;

  // TOOL STAGE (heuristic fallback) — runs for tool-like requests in chat mode.
  // Chat mode never sends tool definitions to Ollama (saves ~900 tokens per request).
  // Agent mode has its own tool loop in runAgentLoop.
  if (mode !== 'agent' && intent.wantsTool && intent.toolId) {
    onStage('tool:executing');
    const lastMsg = messages[messages.length - 1];
    const userInput = lastMsg.content;
    try {
      const result = await executeTool(intent.toolId, intent.toolParams || {}, { userInput });
      toolOutput = result.output;
      toolStageHandled = true;
      toolSucceeded = result.success;
      console.log(`[pipeline] Tool "${intent.toolId}" result: ${result.output.substring(0, 100)}`);
    } catch (e) {
      console.error(`[pipeline] Tool "${intent.toolId}" failed:`, e);
      toolOutput = `Sorry, the ${intent.toolId} tool encountered an error.`;
      toolStageHandled = true;
      toolSucceeded = false;
    }
  }

  // Simple chat — no pipeline needed (injects agent awareness in agent mode)
  if (!intent.hasImage && !intent.wantsCode) {
    // A SUCCESSFUL heuristic tool result is returned directly (e.g. "2 + 2 = 4").
    // A FAILED tool never becomes the answer — it's passed to the AI below so
    // the conversation stays answerable.
    if (toolStageHandled && toolSucceeded && toolOutput) {
      // Send tool output through onChunk so the client receives it AND fullResponse is populated
      onChunk(toolOutput);
      return toolOutput;
    }
    onStage('chat:thinking');
    if (mode === 'agent') {
      const fileInfo = fileListing
        ? 'Here are the ACTUAL files in this workspace (read from disk):\n' + fileListing + '\n\nUse this listing to answer questions about files. Do NOT make up files that are not listed here.'
        : 'You cannot read files or list directories directly. If asked about files, say you cannot see them and offer to generate code instead.';

      // NOTE: Behavioral rules live in AI_RULES.md and are injected by
      // withAiRules(). This prompt only contains structural context.
      const agentSystem = withContext(
        await withAiRules(
          'You are an AI coding agent helping ' + (userName || 'a user') + ' build projects in their workspace.\n' +
          'Your workspace is at: ' + (workspacePath || '(not set)') + '\n\n' +
          fileInfo +
          '\n\nIf asked a question, answer conversationally.\n' +
          'All file operations are limited to your workspace. Do NOT reference files outside it.',
          'agent'
        )
      );

      const agentMessages: Message[] = [
        { role: 'system', content: agentSystem },
        ...messages,
      ];
      return await runVisibleStage('chat', model, agentMessages, think, onChunk, signal, { temperature, top_p, max_tokens }, onThinking);
    }

    // Build context messages for plain chat
    const contextParts: string[] = [];
    if (memoryContext) contextParts.push(memoryContext);
    if (webContext) {
      contextParts.push(
        `[WEB SEARCH RESULTS — CURRENT AND LIVE]\n\nThe information below was retrieved from the internet in real-time through a web search. It is MORE CURRENT than my training data.\n\nINSTRUCTIONS TO ANSWER:\n- I MUST answer the user's question using THESE search results as my primary source of truth\n- I should answer DIRECTLY with the facts from these results — do NOT just provide links or tell the user to visit websites\n- If the results contain the answer, state it clearly and confidently in my response\n- I should treat this information as accurate and current\n- Only mention website URLs if the user specifically asks for sources\n- If the results don't contain enough info to answer, I should say so honestly\n\nSearch results:\n${webContext}`
      );
    }
    const combinedContext = contextParts.length > 0 ? contextParts.join('\n\n---\n\n') : null;

    // Chat rules apply to every plain-chat message (core + chat section only).
    // The persona below is the anti-robot layer: no meta-commentary, no
    // clinical phrasing — the AI should read like a friend having a chat.
    const chatSystem = await withAiRules(
      `You are a real person — a friend the user is chatting with, not a chatbot.
Be conversational: contractions, short answers, match their tone.
Lead with the answer. Never open with "I can provide...", "Based on...", "As an AI...", "Great question!".
Answer their ACTUAL question — never go off-topic.
Never fabricate facts, numbers, dates, or sources. Say "I don't know" if unsure.
Never apologize — just fix it and move on.
Keep answers concise unless asked for detail.
Refuse dangerous requests in one short sentence, then offer alternatives.`,
      'chat'
    );
    const chatSystemMessages: Message[] = [
      {
        role: 'system',
        content: chatSystem + (toolStageHandled && !toolSucceeded
          ? `\n\n[A tool was attempted but failed: ${toolOutput}. Answer the user's question normally — don't dwell on the tool unless it genuinely helps.]`
          : ''),
      },
      ...(combinedContext ? [{ role: 'system' as const, content: combinedContext }] : []),
    ];
    const chatMessages: Message[] = [...chatSystemMessages, ...messages];

    // Give the model web_search + draw_image so it can decide when to look
    // something up or draw a picture — far lighter than the full tool set.
    // Image requests route through the shared draw path (tool nudge + a
    // guaranteed SVG-authoring fallback) so a picture always appears.
    if (detectImageRequest(userText)) {
      return await runDrawImageChat({
        model,
        systemMessages: chatSystemMessages,
        messages,
        requestText: userText,
        think,
        signal,
        temperature,
        top_p,
        max_tokens,
        onChunk,
        onThinking,
        onStage,
      });
    }

    const reply = await runChatToolLoop('chat', model, chatMessages, think, onChunk, signal, { temperature, top_p, max_tokens }, onThinking, undefined, toChatTools());
    return reply;
  }

  let imageDescription = '';
  let planOutput = '';
  let codeOutput = '';


  // STAGE 1: Vision analysis (INTERNAL — user doesn't see this)
  if (intent.hasImage && intent.imageDataUrl) {
    onStage('vision:analyzing');

    const visionMessages: Message[] = [
      {
        role: 'system',
        content: `You are a vision description assistant. Your ONLY job is to describe what you see in the image in plain text.

Rules:
- Describe layout, colors, typography, components, structure, text content, design style
- Be specific and technical (positions, visual hierarchy)
- Plain text only, 2-4 paragraphs
- NO code, NO HTML, NO CSS, NO JavaScript, NO examples, NO implementations
- NO markdown code blocks
- The description will be used by other AIs to write code, so be thorough but factual`,
      },
      {
        role: 'user',
        content: `Describe this image in detail: [image:${intent.imageDataUrl}]`,
      },
    ];

    try {
      // Vision model doesn't need thinking mode (it's factual description)
      const { model: visionModel, source: visionSource } = await getResolvedModel('vision');
      console.log(`[pipeline] Vision model: ${visionModel} (source: ${visionSource})`);
      imageDescription = await runInternalStage('vision', visionModel, visionMessages, false, signal, { temperature, top_p, max_tokens }, undefined, onStage);
      if (visionSource === 'cloud') {
        const inputTokenEst = estimateTokens(visionMessages.map(m => m.content).join('\n'));
        const outputTokenEst = estimateTokens(imageDescription);
        trackCloudUsage(visionModel, inputTokenEst, outputTokenEst);
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      console.error('[pipeline] Vision stage failed:', e);
    }
  }

  // STAGE 2: Planning (VISIBLE — streamed to user when planning mode is on)
  if (intent.wantsCode && planningEnabled) {
    onStage('planning:create');

    const userText = messages[messages.length - 1].content
      .replace(/\[image:data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+\]/g, '')
      .trim();

    const visionContext = imageDescription
      ? `\nThe user also provided an image with this description: ${imageDescription}`
      : '';

    const planMessages: Message[] = [
      {
        role: 'system',
        content: `You are a technical planning agent helping ${userName || 'a user'} with their coding project.
Your workspace is at: ${workspacePath || '(not set)'}

${fileListing ? `Current workspace files:\n${fileListing}\n` : ''}

Your job is to create a CLEAR, CONCISE plan BEFORE any code is written.

The plan should include:
- A summary of what needs to be done
- The list of files that will be created, modified, or deleted
- The key technical decisions or approach
- Any dependencies or important considerations

Keep it brief — 3-6 bullet points. Do NOT write any code yet. Just plan.

User request: ${userText}${visionContext}

Output ONLY the plan — no introductory text, no conclusion, no code blocks.`,
      },
    ];

    try {
      const { model: planningModel, source: planningSource } = await getResolvedModel('code');
      console.log(`[pipeline] Planning model: ${planningModel} (source: ${planningSource})`);
      planOutput = await runVisibleStage('planning', planningModel, planMessages, false, onChunk, signal, { temperature, top_p, max_tokens });
      console.log(`[pipeline] Planning done. Length: ${planOutput.length}`);
      if (planningSource === 'cloud') {
        const inputTokenEst = estimateTokens(planMessages.map(m => m.content).join('\n'));
        const outputTokenEst = estimateTokens(planOutput);
        trackCloudUsage(planningModel, inputTokenEst, outputTokenEst);
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      console.error('[pipeline] Planning stage failed:', e);
    }
  }

  // STAGE 3: Code generation (INTERNAL — user sees the final summary)
  if (intent.wantsCode) {
    if (!fileListing) onStage('reading:workspace');

    const userText = messages[messages.length - 1].content
      .replace(/\[image:data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+\]/g, '')
      .trim();

    // Read referenced files so the model edits REAL contents, not guesses.
    let refContext = '';
    if (mode === 'agent' && userText) {
      const refContents = await collectReferencedFiles(userText, workspacePath);
      if (refContents) {
        refContext = refContents;
      }
    }

    const codeContext = imageDescription
      ? `Based on this image analysis:\n\n${imageDescription}\n\nUser request: ${userText}\n\nGenerate the code.`
      : userText;

    const planInstructions = planOutput
      ? `\n\n---\n\nA plan has already been created and shared with the user above. Follow this plan EXACTLY when generating code:\n${planOutput}\n\nGenerate code that implements this plan precisely. Do NOT deviate from the plan unless the user explicitly asks for changes.`
      : '';

    let codeSystemPrompt = mode === 'agent'
      ? `You are an expert developer working in a code agent workspace for ${userName || 'a user'}.
Your workspace directory is: ${workspacePath || '(not set)'}

${fileListing ? `Here are the ACTUAL files already in the workspace:\n${fileListing}\n\nDo NOT recreate files that already exist unless the user asks. Update them instead.` : ''}
All file paths you generate MUST be relative to this directory.

Generate clean, working code in markdown code blocks.${refContext ? '\n\n' + refContext : ''}

IMPORTANT: Start EVERY code block with a comment on the FIRST LINE showing the relative file path, like:
// index.html
// src/style.css
// src/app.js
// lib/helper.ts
// backend/routes/api.ts

Use the appropriate comment syntax for each language:
- // for JS/TS/CSS/Go/Rust
- # for Python/YAML/Ruby
- <!-- --> for HTML/XML
- ; for INI
- -- for SQL

EDIT vs NEW FILES:
- For a NEW file: output a code block with the path comment on the first line (e.g. "// src/app.ts") and the ENTIRE new file content.
- For an EXISTING file that you only partially change: use an EDIT block instead — first line "// EDIT: path/to/file.ext" (with the appropriate comment prefix for the language), then the exact old lines under "OLD:", then a line with only ---, then the replacement lines under "NEW:". Example:

// EDIT: src/app.ts
OLD:
const x = 1;
const y = 2;
---
NEW:
const x = 10;
const y = 20;

- The OLD: section must match the CURRENT file content exactly (read it from the provided file contents). Only include the lines you are changing. This keeps edits surgical and fast — do NOT rewrite entire existing files when only part changes.
- For a COMPLETE rewrite of an existing file (most of the file changes), a full code block is acceptable.

- For DELETING a file: output a code block with "// DELETE: path/to/file.ext" as the only line.

CRITICAL: Output ONLY code blocks. No explanations before or after.` + planInstructions
      : `You are an expert developer. Generate clean, working code based on the user's request.
${refContext ? '\n\n' + refContext + '\n\n' : '\n\n'}${codeContext}

Output code in markdown code blocks.
Start EVERY code block with a comment showing the file path:
// filename.ext

${planInstructions}

Output ONLY code blocks. No explanations before or after.`;

    const codeSystem = withContext(await withAiRules(codeSystemPrompt, mode === 'agent' ? 'agent' : 'chat'));
    const codeMessages: Message[] = [
      { role: 'system', content: codeSystem },
      ...messages,
    ];

    try {
      const { model: codeModel, source: codeSource } = await getResolvedModel('code');
      console.log(`[pipeline] Code model: ${codeModel} (source: ${codeSource})`);
      codeOutput = await runInternalStage('code', codeModel, codeMessages, think, signal, { temperature, top_p, max_tokens }, onThinking, onStage);
      console.log(`[pipeline] Code done. Length: ${codeOutput.length}`);
      if (codeSource === 'cloud') {
        const inputTokenEst = estimateTokens(codeMessages.map(m => m.content).join('\n'));
        const outputTokenEst = estimateTokens(codeOutput);
        trackCloudUsage(codeModel, inputTokenEst, outputTokenEst);
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      console.error('[pipeline] Code generation failed:', e);
      codeOutput = `I encountered an error generating code. Please try again.\n\nError: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ─── Final response (internal — summarize pipeline output for the user)
  // The code and image stages above ran silently. Now compose a user-facing
  // summary that shows what was done.
  onStage('chat:thinking');

  const pipelineContext: string[] = [];
  if (imageDescription) pipelineContext.push(`The user's image shows: ${imageDescription}`);
  if (planOutput) pipelineContext.push(`Plan created:\n${planOutput}`);
  if (codeOutput) pipelineContext.push(`Generated code:\n${codeOutput}`);

  const summaryPrompt = pipelineContext.length > 0
    ? `The pipeline has completed. Here is a summary of the results:\n\n${pipelineContext.join('\n\n---\n\n')}\n\nNow provide a brief, friendly summary to the user. If there's code, present the key files. If there's a plan, present it. Be conversational — not robotic.`
    : 'The pipeline has completed but produced no output. Tell the user something went wrong and ask them to try again.';

  const summaryMessages: Message[] = [
    { role: 'system', content: await withAiRules(
      `You are a helpful assistant summarizing pipeline output for the user.
Be concise and conversational. Present results clearly.`,
      'chat'
    ) },
    ...messages,
    { role: 'user', content: summaryPrompt },
  ];

  return await runVisibleStage('chat', model, summaryMessages, false, onChunk, signal, { temperature, top_p, max_tokens }, onThinking);
}
