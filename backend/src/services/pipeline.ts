import { promises as fs } from 'fs';
import path from 'path';
import { streamChat, streamChatWithTools, modelSupportsTools, modelSupportsThinking } from './ollama';
import type { ToolLoopMessage } from './ollama';
import { getMemory } from './memory';
import { getModelAssignment } from './model-assignments';
import { getWebContext } from './search';
import { generateImage } from './image';
import { executeTool, detectTool, getAllTools, isProbablyMathExpression } from './tools/index';
import type { ToolResult } from './tools/index';
import { runAgentLoop, collectReferencedFiles } from './agent';
import { withAiRules } from './ai-rules';
import { findDangerousRequest, DANGEROUS_REPLY } from './content-guard';
import type { ConversationMode, Message } from '../types';

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
  /** Agent mode: whether the AI may write/delete files directly (tool loop) */
  autoApply?: boolean;
  /** Agent mode: fired when the AI writes/deletes a file (for live UI updates) */
  onFileWritten?: (write: { path: string; changeType: string; originalContent?: string }) => void;
  /** Agent mode: fired when the AI starts a tool call */
  onAgentTool?: (call: { tool: string; args: Record<string, unknown> }) => void;
  /** Fired with each reasoning chunk from thinking models (qwen3, deepseek-r1, etc.) */
  onThinking?: (chunk: string) => void;
  /** Agent mode: fired when the AI runs a shell command or auto-verify (terminal feed) */
  onAgentCommand?: (cmd: { command: string; output: string; failed: boolean }) => void;
  /** Agent mode: fired when the AI asks the user a clarifying question (ask_user) */
  onQuestion?: (key: string, question: string) => void;
  /** Agent mode: fired when a run is stopped/capped so the caller can persist resume state */
  onResumeState?: (state: { history: { role: string; content: string }[] }) => void;
  /** Agent mode: resume a previously stopped run */
  resumeState?: { history: { role: string; content: string }[] };
  /** Routing key for ask_user answers (usually the conversation id) */
  conversationId?: string;
}

interface DetectedIntent {
  hasImage: boolean;
  wantsCode: boolean;
  wantsFileInfo: boolean;
  wantsImage: boolean;
  wantsTool: boolean;
  toolId?: string;
  toolParams?: Record<string, unknown>;
  imageDataUrl?: string;
  imagePrompt?: string;
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

  // Search when there's a clear question about external information
  const isQuestion = lower.includes('?');
  const startsWithQuestionWord = /^(what|who|where|when|why|how)\b/i.test(lower.trim());
  const containsFactualNeed = /\b(current|latest|recent|news|update|today'?s|population|weather|price|cost|distance|temperature|forecast|schedule|deadline|release|announcement|election|president|ceo|founder|invented|discovered)\b/i.test(lower);

  return isQuestion || startsWithQuestionWord || containsFactualNeed;
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
    return { hasImage: false, wantsCode: false, wantsFileInfo: false, wantsImage: false, wantsTool: false };
  }

  const content = last.content.toLowerCase();
  const hasImage = content.includes('[image:data:image');

  // Detect if user wants to use a tool (async — uses dynamic import)
  const toolMatch = await detectTool(last.content);
  const wantsTool = !!toolMatch;
  const toolId = toolMatch?.toolId;
  const toolParams = toolMatch?.params;

  // Detect if user wants image generation
  const imagePhrases = [
    'generate an image', 'generate a picture', 'generate a photo',
    'create an image', 'create a picture', 'create a photo',
    'make an image', 'make a picture', 'make a photo',
    'draw', 'paint', 'render an image', 'render a picture',
    'image of', 'picture of', 'generate me',
    'create me', 'make me', 'generate art',
    'ai image', 'generate image', 'generate picture',
  ];
  const wantsImage = !content.includes('[image:') && imagePhrases.some((phrase) => content.includes(phrase));

  // Extract the image prompt (text without any [image:...] tags)
  const imagePrompt = wantsImage
    ? last.content.replace(/\[image:[^\]]+\]/g, '').trim()
    : undefined;

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

  // Broader code-related phrases for agent mode (catches more requests).
  // These are multi-word requests or strong code signals — NOT bare generic
  // words like "app" or "file", so conversational messages like "tell me
  // about yourself" or "what do you think of this design?" do NOT trigger
  // the heavy code pipeline.
  const agentCodePhrases = [
    'write a', 'write an', 'write the', 'write code', 'write a function',
    'write a script', 'write a program', 'write a component', 'write a file',
    'generate a', 'generate an', 'generate code', 'generate a function',
    'generate a component',
    'create a', 'create an', 'create code', 'create a function',
    'create a script', 'create a component', 'create a file', 'create a page',
    'build a', 'build an', 'build a website', 'build an app', 'build a page',
    'build a component', 'build a project',
    'make a', 'make an', 'make a website', 'make an app', 'make a page',
    'make a component', 'make a file',
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
    // Agent mode: phrase-based detection only — there is NO blanket
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

  return { hasImage, wantsCode, wantsFileInfo, wantsImage, wantsTool, toolId, toolParams, imageDataUrl, imagePrompt };
}

// Internal stage: runs the model without streaming output to user
async function runInternalStage(
  stageName: string,
  model: string,
  messages: Message[],
  think: boolean,
  signal?: AbortSignal,
  extraOpts: { temperature?: number; top_p?: number; max_tokens?: number } = {},
  onThinking?: (chunk: string) => void
): Promise<string> {
  console.log(`[pipeline] Internal stage "${stageName}" — model: ${model}, think: ${think}`);
  let output = '';
  try {
    await streamChat(
      model,
      messages,
      (chunk) => {
        output += chunk;
      },
      { signal, think, ...extraOpts, onThinking }
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
      { signal, think, ...extraOpts, onThinking }
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
 * Only runs in agent mode before code generation.
 */
// ─── Model-driven tool calling ────────────────────────────

const MAX_TOOL_ROUNDS = 4;

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
  onStage?: (stage: string) => void
): Promise<string> {
  const tools = toOllamaTools();
  const loopMessages: ToolLoopMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const userInput = lastUserMsg?.content ?? '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    onStage?.(round === 0 ? 'chat:thinking' : 'tool:executing');
    console.log(`[pipeline] Tool round ${round + 1}/${MAX_TOOL_ROUNDS} — ${model}`);
    const { content, toolCalls } = await streamChatWithTools(model, loopMessages, tools, onChunk, {
      signal,
      think,
      ...extraOpts,
      onThinking,
    });

    if (!toolCalls.length) return content;

    // Record what the model wanted to do, then feed the results back.
    loopMessages.push({ role: 'assistant', content, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const name = tc.function?.name ?? 'unknown';
      const args = tc.function?.arguments ?? {};
      let result: ToolResult;
      try {
        result = await executeTool(name, args, { userInput });
      } catch (e) {
        result = { success: false, output: `Tool "${name}" crashed: ${e instanceof Error ? e.message : String(e)}` };
      }
      console.log(`[pipeline] Tool "${name}" → ${result.success ? 'ok' : 'error'}: ${result.output.substring(0, 80)}`);
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
  return final.content;
}

const DOCS_QUERY_MAP: Record<string, string[]> = {
  react: ['react', 'reactjs', 'jsx', 'tsx', 'nextjs', 'next.js'],
  vue: ['vue', 'vuejs', 'nuxt', 'nuxtjs'],
  angular: ['angular'],
  python: ['python', 'django', 'flask', 'fastapi', 'pandas', 'numpy'],
  javascript: ['javascript', 'js', 'node', 'node.js', 'express', 'npm', 'es6'],
  typescript: ['typescript', 'ts', 'deno', 'bun'],
  html: ['html', 'html5', 'css', 'css3', 'tailwind', 'bootstrap'],
  go: ['go', 'golang'],
  rust: ['rust', 'cargo'],
  java: ['java', 'spring', 'maven', 'gradle'],
  sql: ['sql', 'postgresql', 'mysql', 'sqlite', 'database'],
  // Add more as needed
};

async function detectLanguageForDocs(userText: string, fileListing: string): Promise<string | null> {
  const lower = userText.toLowerCase() + ' ' + fileListing.toLowerCase();
  
  // Score each language based on keyword mentions
  const scores: { lang: string; score: number }[] = [];
  for (const [lang, keywords] of Object.entries(DOCS_QUERY_MAP)) {
    let score = 0;
    for (const kw of keywords) {
      const regex = new RegExp(`\\b${kw.replace(/[.+^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      const matches = lower.match(regex);
      if (matches) score += matches.length * (kw === lang ? 3 : 1);
    }
    if (score > 0) scores.push({ lang, score });
  }
  
  scores.sort((a, b) => b.score - a.score);
  return scores.length > 0 ? scores[0].lang : null;
}

async function fetchDocsForLanguage(language: string): Promise<string | null> {
  // Search for documentation about the detected language/framework
  const query = `${language} documentation best practices 2025 2026`;
  try {
    const context = await getWebContext(query);
    if (context && context.length > 200) {
      return `[LANGUAGE DOCUMENTATION REFERENCE]\n\nThe user appears to be working with **${language}**. Here is current documentation and best practices retrieved from the web:\n\n${context}`;
    }
  } catch (e) {
    console.error(`[pipeline] Docs lookup failed for ${language}:`, e);
  }
  return null;
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

  // ─── Adaptive thinking ────────────────────────────────────
  // 'off' never thinks; otherwise (default 'auto') decide per message whether
  // reasoning actually helps. When thinking IS needed but the base chat model
  // can't think, route to the dedicated Chat (Thinking) model instead.
  const thinkingMode: 'auto' | 'off' = opts.thinkingMode ?? (opts.thinkingEnabled === false ? 'off' : 'auto');
  const lastUserMsgForThink = [...messages].reverse().find((m) => m.role === 'user');
  const think = thinkingMode === 'off' ? false : needsThinking(lastUserMsgForThink?.content ?? '');
  console.log(`[pipeline] Thinking mode: ${thinkingMode} → think: ${think}`);
  if (think && !modelSupportsThinking(model)) {
    const thinkingModel = await getModelAssignment('chat_thinking');
    if (thinkingModel && thinkingModel !== model) {
      console.log(`[pipeline] Auto-thinking: ${model} can't think → using ${thinkingModel}`);
      model = thinkingModel;
    }
  }

  // ─── AGENT LOOP (auto-apply mode) ─────────────────────────
  // In auto-apply mode the AI is autonomous: it can read files, run
  // commands, write and delete files, and iterate until the task is done.
  // Image/vision requests stay on the regular pipeline (they need the
  // vision-analysis and image-generation stages).
  if (mode === 'agent' && opts.autoApply === true && !intent.hasImage && !intent.wantsImage) {
    console.log('[pipeline] Agent mode with auto-apply — running autonomous loop');
    const memoryContext = await buildMemoryContext(userId);
    return await runAgentLoop({
      model,
      messages,
      workspacePath,
      autoApply: true,
      userName,
      signal,
      think,
      askKey: opts.conversationId,
      resumeState: opts.resumeState,
      callbacks: {
        onStage,
        onChunk,
        onToolStart: opts.onAgentTool,
        onFileWritten: opts.onFileWritten,
        onThinking,
        onAgentCommand: opts.onAgentCommand,
        onQuestion: opts.onQuestion,
        onResumeState: opts.onResumeState,
      },
      temperature,
      top_p,
      max_tokens,
      extraContext: memoryContext || undefined,
    });
  }

  console.log(`[pipeline] Intent: hasImage=${intent.hasImage}, wantsCode=${intent.wantsCode}, wantsFileInfo=${intent.wantsFileInfo}, wantsImage=${intent.wantsImage}, wantsTool=${intent.wantsTool}, think=${think}`);

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
  const shouldSearch = !intent.hasImage && !intent.wantsImage && userText.length > 0 && needsWebSearch(userText);

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
  if (userText && !shouldSearch && !intent.hasImage && !intent.wantsImage) {
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

  // TOOL STAGE (heuristic fallback) — only runs when the chat model can't call
  // tools itself. Tool-capable models use the model-driven loop further down.
  const chatSupportsTools = mode !== 'agent' && modelSupportsTools(model);
  if (!chatSupportsTools && intent.wantsTool && intent.toolId) {
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
  if (!intent.hasImage && !intent.wantsCode && !intent.wantsImage) {
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

      const agentSystem = withContext(
        await withAiRules(
          'You are an AI coding agent helping ' + (userName || 'a user') + ' build projects in their workspace.\n' +
          'Your workspace is at: ' + (workspacePath || '(not set)') + '\n\n' +
          fileInfo +
          '\n\nCRITICAL RULES FOR CODE BLOCKS:\n' +
          '1) ALWAYS start EVERY code block with a file path comment on the FIRST LINE.\n' +
          '   Example: `// index.html` then the HTML on the next line.\n' +
          '   Example: `# main.py` then Python code.\n' +
          '   Example: `<!-- app.component.html -->` then Angular template.\n' +
          '2) The file path MUST include a file extension (.html, .py, .ts, .css, etc.).\n' +
          '3) Use relative paths like src/index.ts, components/Button.tsx, etc.\n' +
          '4) NEVER output a code block without a file path comment on the first line.\n' +
          '\n' +
          'CRITICAL — You MUST output the COMPLETE file content in every code block. NEVER use placeholders like "# rest of the code", "...", "// remaining code unchanged", or similar shortcuts. Every code block must be the ENTIRE file from start to finish.\n' +
          '\n' +
          'To DELETE a file, output a code block with the first line as: `// DELETE: path/to/file.ext`\n' +
          'and NO other content in the code block.\n' +
          '\n' +
          'If asked a question, answer conversationally.\n' +
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
      `You are a real person — a friend the user is chatting with, not a chatbot or a customer-service rep.

HOW TO TALK (this matters more than anything):
- Sound human: use contractions ("I'm", "don't", "that's") and natural, conversational phrasing.
- Lead with the answer. NEVER open with meta-commentary like "I can provide some context", "Based on available data", "Here is what I found", "According to studies", "As an AI", "I'd be happy to help", or "Great question!".
- Match the user's tone and length. A short question gets a short answer. Don't write essays or pad with filler.
- Skip the robot tells: no "It's important to note", "In conclusion", "Overall,", "Research suggests that", and no clinical bullet lists unless the user asked for one.
- Answer the user's ACTUAL question. Never respond with something that belongs to a different topic.
- Facts: never invent numbers, statistics, dimensions, prices, dates, names, quotes, or sources. If asked a factual question you genuinely don't know, say "I don't know" plainly. If you have a web search tool and need a fact you can't verify from memory, look it up.
- Refuse genuinely illegal or dangerous requests — making bombs or weapons, doxxing, fraud, malware — in one calm, short sentence, no sermon, then offer the closest legal alternative if one exists.`,
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

    if (chatSupportsTools) {
      try {
        return await runChatToolLoop('chat', model, chatMessages, think, onChunk, signal, { temperature, top_p, max_tokens }, onThinking, onStage);
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') throw e;
        console.warn(`[pipeline] Tool calling failed, falling back to plain chat: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return await runVisibleStage('chat', model, chatMessages, think, onChunk, signal, { temperature, top_p, max_tokens }, onThinking);
  }

  let imageDescription = '';
  let planOutput = '';
  let codeOutput = '';
  let generatedImageFilename: string | undefined;
  let imageGenNote = '';

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
      const visionModel = await getModelAssignment('vision');
      imageDescription = await runInternalStage('vision', visionModel, visionMessages, false, signal, { temperature, top_p, max_tokens });
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
      const planningModel = await getModelAssignment('code');
      planOutput = await runVisibleStage('planning', planningModel, planMessages, false, onChunk, signal, { temperature, top_p, max_tokens });
      console.log(`[pipeline] Planning done. Length: ${planOutput.length}`);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      console.error('[pipeline] Planning stage failed:', e);
    }
  }

  // STAGE 3: Image generation (VISIBLE — when user wants an image)
  if (intent.wantsImage && intent.imagePrompt) {
    const userText = intent.imagePrompt;

    const imageModel = await getModelAssignment('image_generation');

    // Try to generate image
    try {
      if (!imageModel) {
        // No image model assigned (set to None in the Server App) — tell the
        // user instead of calling Ollama with an empty model name.
        console.log('[pipeline] Image generation skipped: no model assigned');
        imageGenNote = '\n\n(Image generation is not set up — assign an image model in the Server App → Models to enable it.)';
      } else {
        onStage('image:generating');

        // We run this as a visible stage that sends status updates
        // but the actual image data is returned via the done event
        console.log(`[pipeline] Generating image with model: ${imageModel}`);

        const result = await generateImage(userText, imageModel, signal);
        generatedImageFilename = result.filename;

        console.log(`[pipeline] Image generated: ${result.filename}`);
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      console.error('[pipeline] Image generation failed:', e);
      // Don't abort — continue with code generation or final response
    }
  }

  // STAGE 4: Code generation (INTERNAL — user sees the final summary)
  if (intent.wantsCode) {
    if (!fileListing) onStage('reading:workspace');

    const userText = messages[messages.length - 1].content
      .replace(/\[image:data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+\]/g, '')
      .trim();

    // Agent mode docs lookup: detect language and fetch docs before code gen
    let docsContext = '';
    if (mode === 'agent' && userText) {
      onStage('search:docs');
      const detectedLang = await detectLanguageForDocs(userText, fileListing);
      if (detectedLang) {
        console.log(`[pipeline] Detected language for docs: ${detectedLang}`);
        const docs = await fetchDocsForLanguage(detectedLang);
        if (docs) {
          docsContext = `\n\n---\n\n${docs}`;
        }
      }

      // Read referenced files so the model edits REAL contents, not guesses.
      const refContents = await collectReferencedFiles(userText, workspacePath);
      if (refContents) {
        docsContext += refContents;
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

${fileListing ? `Here are the ACTUAL files already in the workspace:
${fileListing}

Do NOT recreate files that already exist unless the user asks. Update them instead.` : ''}
All file paths you generate MUST be relative to this directory.

Generate clean, working code in markdown code blocks.
${docsContext}

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

CRITICAL — COMPLETE FILES ONLY for new files and rewrites: Every full-file code block MUST contain the ENTIRE file from start to finish. NEVER use placeholders like "# rest of the code", "...", "// remaining code unchanged", or similar shortcuts. Partial code with placeholders will corrupt the user's files.

After the code blocks, write a 1-2 sentence technical summary.${planInstructions}`
      : `You are an expert developer. Generate clean, working code in markdown code blocks with language tags. After the code, write a 1-2 sentence technical summary of what you built.${planInstructions}`;

    // Inject the AI ruleset — agent mode gets core + agent rules, chat gets core + chat rules
    codeSystemPrompt = await withAiRules(codeSystemPrompt, mode === 'agent' ? 'agent' : 'chat');

    const codeMessages: Message[] = [
      {
        role: 'system',
        content: codeSystemPrompt,
      },
      ...messages.slice(0, -1),
      { role: 'user', content: codeContext },
    ];

    try {
      // Code model doesn't need thinking mode either
      const codeModel = await getModelAssignment('code');
      // Tell the UI the code model is now running. It streams internally, so
      // without this stage the previous one (often 'search:docs') stays on
      // screen for the entire generation.
      onStage('code:generating');
      codeOutput = await runInternalStage('code', codeModel, codeMessages, false, signal, { temperature, top_p, max_tokens });
      // After code generation completes, show writing stage
      onStage('writing:files');
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      console.error('[pipeline] Code stage failed:', e);
    }


  }

  // STAGE 4: Final response (VISIBLE to user)
  onStage('summary:writing');

  // Build the generated image tag to include in the final response
  const imageTag = generatedImageFilename
    ? `\n\n[generated_image:${generatedImageFilename}]`
    : '';

  let finalMessages: Message[];

  if (codeOutput) {
    // Code request with image (or just code)
    const userText = messages[messages.length - 1].content
      .replace(/\[image:data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+\]/g, '')
      .trim();

    const finalSystemPrompt = mode === 'agent'
      ? `You are a friendly AI coding agent working in a file workspace, helping ${userName || 'the user'}.
Your workspace is at: ${workspacePath || '(not set)'}
All files you work on live inside this directory.

${fileListing ? `Current workspace files:
${fileListing}

` : ''}The user asked: "${userText}"

${imageDescription ? `Vision analysis of the image: ${imageDescription}\n\n` : ''}A code AI generated this:

${codeOutput}

Your job: Write a brief, friendly response (3-5 sentences) that:
- States which files were created or modified
- Includes the code in markdown code blocks with their FILE PATH COMMENTS on the first line (copy EXACTLY from the code above — the file path markers are REQUIRED)
- CRITICAL: Each code block must contain the COMPLETE file — NEVER use "# rest of the code", "...", or similar placeholders
- Is conversational and helpful
- Do NOT repeat technical analysis verbatim`
      : `You are a friendly assistant. The user asked: "${userText}"

${imageDescription ? `Vision analysis of the image: ${imageDescription}\n\n` : ''}A code AI generated this:

${codeOutput}

Your job: Write a brief, friendly response (3-5 sentences) that:
- Acknowledges what was built in plain language
- Includes the code in markdown code blocks (copy from the code above)
- Is conversational and helpful
- Doesn't repeat the analysis verbatim`;

    finalMessages = [
      {
        role: 'system',
        content: finalSystemPrompt,
      },
    ];
  } else if (generatedImageFilename) {
    // Image generation only (no code)
    const userText = intent.imagePrompt || messages[messages.length - 1].content
      .replace(/\[image:[^\]]+\]/g, '').trim();

    finalMessages = [
      {
        role: 'system',
        content: `You are a friendly assistant. The user asked you to generate an image.

Their request: "${userText}"

The image was generated successfully.

Your job: Write a brief, friendly response (2-3 sentences) describing what was generated. Mention any notable details about the image. Be enthusiastic but concise.`,
      },
    ];
  } else if (imageDescription) {
    // Image only, no code request
    finalMessages = [
      {
        role: 'system',
        content: `You are a friendly assistant. The user sent an image.

Vision AI description: ${imageDescription}

Your job: Write a brief, friendly response (2-3 sentences) that describes what's in the image in conversational language. Don't mention the AI analysis process.`,
      },
    ];
  } else {
    // Fallback (shouldn't happen given intent detection)
    finalMessages = messages;
  }

  // Run the final visible stage
  let finalOutput = await runVisibleStage('final', model, finalMessages, think, onChunk, signal, { temperature, top_p, max_tokens }, onThinking);

  // Programmatically append the generated image tag (reliable — not left to AI discretion)
  if (generatedImageFilename) {
    finalOutput += `\n\n[generated_image:${generatedImageFilename}]`;
  }

  // Append a note when image generation was requested but no model is assigned.
  if (imageGenNote) {
    finalOutput += imageGenNote;
  }

  return finalOutput;
}
