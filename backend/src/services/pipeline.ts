import { streamChat } from './ollama';
import type { Message } from '../types';

const VISION_MODEL = process.env.VISION_MODEL || 'qwen2.5vl:3b';
const CODE_MODEL = process.env.CODE_MODEL || 'qwen2.5-coder:7b';
const TEXT_MODEL = process.env.TEXT_MODEL || 'qwen3:4b';

// Global default for thinking mode. Can be overridden per-request.
const THINKING_ENABLED = process.env.THINKING_MODE === 'true';

interface PipelineOptions {
  model: string;
  messages: Message[];
  signal?: AbortSignal;
  onStage: (stage: string) => void;
  onChunk: (chunk: string) => void;
  thinkingEnabled?: boolean;
}

interface DetectedIntent {
  hasImage: boolean;
  wantsCode: boolean;
  imageDataUrl?: string;
}

function detectIntent(messages: Message[]): DetectedIntent {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') {
    return { hasImage: false, wantsCode: false };
  }

  const content = last.content.toLowerCase();
  const hasImage = content.includes('[image:data:image');

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

  const wantsCode = codePhrases.some((phrase) => content.includes(phrase));

  let imageDataUrl: string | undefined;
  const match = last.content.match(/\[image:(data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+))\]/);
  if (match) imageDataUrl = match[1];

  return { hasImage, wantsCode, imageDataUrl };
}

// Internal stage: runs the model without streaming output to user
async function runInternalStage(
  stageName: string,
  model: string,
  messages: Message[],
  think: boolean,
  signal?: AbortSignal
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
      { signal, think }
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
  signal?: AbortSignal
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
      { signal, think }
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

export async function runPipeline(opts: PipelineOptions): Promise<string> {
  const { model, messages, signal, onStage, onChunk, thinkingEnabled } = opts;
  const intent = detectIntent(messages);

  // Determine thinking mode: request override > env default
  const think = thinkingEnabled !== undefined ? thinkingEnabled : THINKING_ENABLED;

  console.log(`[pipeline] Intent: hasImage=${intent.hasImage}, wantsCode=${intent.wantsCode}, think=${think}`);

  // Simple chat — no pipeline needed
  if (!intent.hasImage && !intent.wantsCode) {
    onStage('chat:thinking');
    return await runVisibleStage('chat', model, messages, think, onChunk, signal);
  }

  let imageDescription = '';
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
      imageDescription = await runInternalStage('vision', VISION_MODEL, visionMessages, false, signal);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      console.error('[pipeline] Vision stage failed:', e);
    }
  }

  // STAGE 2: Code generation (INTERNAL — user sees the final summary)
  if (intent.wantsCode) {
    onStage('code:generating');

    const userText = messages[messages.length - 1].content
      .replace(/\[image:data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+\]/g, '')
      .trim();

    const codeContext = imageDescription
      ? `Based on this image analysis:\n\n${imageDescription}\n\nUser request: ${userText}\n\nGenerate the code.`
      : userText;

    const codeMessages: Message[] = [
      {
        role: 'system',
        content: 'You are an expert developer. Generate clean, working code in markdown code blocks with language tags. After the code, write a 1-2 sentence technical summary of what you built.',
      },
      ...messages.slice(0, -1),
      { role: 'user', content: codeContext },
    ];

    try {
      // Code model doesn't need thinking mode either
      codeOutput = await runInternalStage('code', CODE_MODEL, codeMessages, false, signal);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      console.error('[pipeline] Code stage failed:', e);
    }
  }

  // STAGE 3: Final response (VISIBLE to user)
  onStage('summary:writing');

  let finalMessages: Message[];

  if (codeOutput) {
    // Code request with image (or just code)
    const userText = messages[messages.length - 1].content
      .replace(/\[image:data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+\]/g, '')
      .trim();
    finalMessages = [
      {
        role: 'system',
        content: `You are a friendly assistant. The user asked: "${userText}"

${imageDescription ? `Vision analysis of the image: ${imageDescription}\n\n` : ''}A code AI generated this:

${codeOutput}

Your job: Write a brief, friendly response (3-5 sentences) that:
- Acknowledges what was built in plain language
- Includes the code in markdown code blocks (copy from the code above)
- Is conversational and helpful
- Doesn't repeat the analysis verbatim`,
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

  return await runVisibleStage('final', model, finalMessages, think, onChunk, signal);
}
