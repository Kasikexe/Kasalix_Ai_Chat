import { promises as fs } from 'fs';
import path from 'path';
import { streamChat } from './ollama';
import { getMemory } from './memory';
import { getModelAssignment } from './model-assignments';
import { getWebContext } from './search';
import { generateImage } from './image';
import { executeTool, detectTool } from './tools/index';
import type { ConversationMode, Message } from '../types';

// Global default for thinking mode. Can be overridden per-request.
const THINKING_ENABLED = process.env.THINKING_MODE === 'true';

interface PipelineOptions {
  model: string;
  messages: Message[];
  mode?: ConversationMode;
  workspacePath?: string;
  signal?: AbortSignal;
  onStage: (stage: string) => void;
  onChunk: (chunk: string) => void;
  thinkingEnabled?: boolean;
  userId?: string;
  userName?: string;
  searchEnabled?: boolean;
  planningEnabled?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
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
]);

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

  // Broader code-related phrases for agent mode (catches more requests)
  const agentCodePhrases = [
    ...['write', 'generate', 'create', 'build', 'make', 'code', 'implement',
       'convert', 'turn', 'remake', 'recreate', 'show'],
    'html page', 'css code', 'web page', 'app', 'website',
    'function', 'script', 'program', 'component', 'file',
    'project', 'template', 'ui', 'interface', 'style', 'layout',
    'in html', 'in css', 'in javascript', 'in python', 'in typescript',
    'in react', 'in vue', 'in go', 'in rust', 'in java',
  ];

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
    // In agent mode, use a broader but still sensible heuristic:
    // trigger code pipeline for messages that look like they involve code/files
    const isShortQuery = content.split(/\s+/).length < 4;
    if (isShortQuery) {
      // Short queries like "hi", "hello", "thanks" skip the code pipeline
      // unless they match the agent code phrases
      wantsCode = agentCodePhrases.some((phrase) => content.includes(phrase));
    } else {
      // Longer queries likely involve code; run the code pipeline
      wantsCode = true;
    }
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
  extraOpts: { temperature?: number; top_p?: number; max_tokens?: number } = {}
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
      { signal, think, ...extraOpts }
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
  extraOpts: { temperature?: number; top_p?: number; max_tokens?: number } = {}
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
      { signal, think, ...extraOpts }
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
  const { model, messages, mode, workspacePath, signal, onStage, onChunk, thinkingEnabled, userId, userName, searchEnabled, planningEnabled, temperature, top_p, max_tokens } = opts;
  const intent = await detectIntent(messages, mode);

  // Determine thinking mode: request override > env default
  // Agent mode always uses fast mode (thinking disabled)
  const think = mode === 'agent' ? false : (thinkingEnabled !== undefined ? thinkingEnabled : THINKING_ENABLED);

  console.log(`[pipeline] Intent: hasImage=${intent.hasImage}, wantsCode=${intent.wantsCode}, wantsFileInfo=${intent.wantsFileInfo}, wantsImage=${intent.wantsImage}, wantsTool=${intent.wantsTool}, think=${think}`);

  // If user asks about files (or planning mode is on), read the actual directory listing and inject it
  let fileListing = '';
  const needsFileListing = intent.wantsFileInfo || (intent.wantsCode && planningEnabled);
  if (needsFileListing && workspacePath) {
    onStage('reading:workspace');
    fileListing = await listWorkspaceFiles(workspacePath);
    console.log(`[pipeline] Workspace file listing: ${fileListing.substring(0, 200)}...`);
  }

  // Build memory context if available
  const memoryContext = await buildMemoryContext(userId);

  // Web search context — automatically performed when appropriate
  let webContext: string | null = null;
  if (!intent.hasImage && !intent.wantsImage) {
    const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
    if (lastUserMsg) {
      onStage('search:web');
      webContext = await getWebContext(
        lastUserMsg.content.replace(/\[image:[^\]]+\]/g, '').trim()
      );
    }
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

  // TOOL STAGE: If the user wants to use a tool, execute it and inject result
  if (intent.wantsTool && intent.toolId) {
    onStage('tool:executing');
    const lastMsg = messages[messages.length - 1];
    const userInput = lastMsg.content;
    try {
      const result = await executeTool(intent.toolId, intent.toolParams || {}, { userInput });
      toolOutput = result.output;
      toolStageHandled = true;
      console.log(`[pipeline] Tool "${intent.toolId}" result: ${result.output.substring(0, 100)}`);
    } catch (e) {
      console.error(`[pipeline] Tool "${intent.toolId}" failed:`, e);
      toolOutput = `Sorry, the ${intent.toolId} tool encountered an error.`;
      toolStageHandled = true;
    }
  }

  // Simple chat — no pipeline needed (injects agent awareness in agent mode)
  if (!intent.hasImage && !intent.wantsCode && !intent.wantsImage) {
    // If we have tool output, inject it into the conversation (skip AI for tools)
    if (toolStageHandled && toolOutput) {
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
        'All file operations are limited to your workspace. Do NOT reference files outside it.'
      );

      const agentMessages: Message[] = [
        { role: 'system', content: agentSystem },
        ...messages,
      ];
      return await runVisibleStage('chat', model, agentMessages, think, onChunk, signal, { temperature, top_p, max_tokens });
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

    if (combinedContext) {
      const chatMessages: Message[] = [
        { role: 'system', content: combinedContext },
        ...messages,
      ];
      return await runVisibleStage('chat', model, chatMessages, think, onChunk, signal, { temperature, top_p, max_tokens });
    }
    return await runVisibleStage('chat', model, messages, think, onChunk, signal, { temperature, top_p, max_tokens });
  }

  let imageDescription = '';
  let planOutput = '';
  let codeOutput = '';
  let generatedImageFilename: string | undefined;

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
      onStage('image:generating');

      // We run this as a visible stage that sends status updates
      // but the actual image data is returned via the done event
      console.log(`[pipeline] Generating image with model: ${imageModel}`);

      const result = await generateImage(userText, imageModel, signal);
      generatedImageFilename = result.filename;

      console.log(`[pipeline] Image generated: ${result.filename}`);
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
    }

    const codeContext = imageDescription
      ? `Based on this image analysis:\n\n${imageDescription}\n\nUser request: ${userText}\n\nGenerate the code.`
      : userText;

    const planInstructions = planOutput
      ? `\n\n---\n\nA plan has already been created and shared with the user above. Follow this plan EXACTLY when generating code:\n${planOutput}\n\nGenerate code that implements this plan precisely. Do NOT deviate from the plan unless the user explicitly asks for changes.`
      : '';

    const codeSystemPrompt = mode === 'agent'
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

CRITICAL — COMPLETE FILES ONLY: Every code block MUST contain the ENTIRE file from start to finish. NEVER use placeholders like "# rest of the code", "...", "// remaining code unchanged", or similar shortcuts. Partial code with placeholders will corrupt the user's files.

After the code blocks, write a 1-2 sentence technical summary.${planInstructions}`
      : `You are an expert developer. Generate clean, working code in markdown code blocks with language tags. After the code, write a 1-2 sentence technical summary of what you built.${planInstructions}`;

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
  let finalOutput = await runVisibleStage('final', model, finalMessages, think, onChunk, signal, { temperature, top_p, max_tokens });

  // Programmatically append the generated image tag (reliable — not left to AI discretion)
  if (generatedImageFilename) {
    finalOutput += `\n\n[generated_image:${generatedImageFilename}]`;
  }

  return finalOutput;
}
