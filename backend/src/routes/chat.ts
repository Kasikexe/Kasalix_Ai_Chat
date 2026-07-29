import { Hono } from 'hono';
import { runPipeline } from '../services/pipeline';
import { addMessage, createConversation, getConversation } from '../services/storage';
import { getMemory } from '../services/memory';
import { extractMemoryFromTurn } from '../services/extractor';
import { chat as ollamaChat, streamChat } from '../services/ollama';
import { logger as appLogger } from '../services/logger';
import type { ConversationMode, Message } from '../types';

const chat = new Hono();

chat.post('/', async (c) => {
  let convId: string | undefined;
  let convMode: ConversationMode = 'chat';
  let convWorkspacePath: string | undefined;

  try {
    const ownerId = c.get('user').id;
    const body = await c.req.json();
    const model: string = body.model;
    const messages: Message[] = body.messages;
    const providedConvId: string | undefined = body.conversationId;
    const thinkingEnabled: boolean = body.thinkingEnabled === true;
    const searchEnabled: boolean = body.searchEnabled === true;
    const mode: ConversationMode = body.mode === 'agent' ? 'agent' : 'chat';
    const reqWorkspacePath: string | undefined = body.workspacePath;
    const temperature: number | undefined = body.temperature;
    const top_p: number | undefined = body.top_p;
    const max_tokens: number | undefined = body.max_tokens;
    const userName: string | undefined = body.userName;
    const planningEnabled: boolean = body.planningEnabled === true;

    if (!model || !Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: 'model and messages are required' }, 400);
    }

    // Create or fetch conversation
    if (providedConvId) {
      const existing = await getConversation(providedConvId, ownerId);
      if (!existing) return c.json({ error: 'Conversation not found' }, 404);
      convId = providedConvId;
      convMode = existing.mode || 'chat';
      convWorkspacePath = existing.workspacePath || reqWorkspacePath;
    } else {
      const newConv = await createConversation(model, ownerId, undefined, mode);
      convId = newConv.id;
      convMode = mode;
      convWorkspacePath = newConv.workspacePath;
    }

    // Save user message (strip image data to save space)
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role === 'user' && convId) {
      const savedContent = lastMessage.content
        .replace(/\[image:data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+\]/g, '[image]');
      await addMessage(convId, ownerId, { ...lastMessage, content: savedContent });
    }

    const encoder = new TextEncoder();
    let aborted = false;
    const activeConvId = convId;
    let fullResponse = '';
    let currentStage = '';

    // Abort controller to stop pipeline if client disconnects
    const ac = new AbortController();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: object) => {
          if (aborted) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            // controller already closed
          }
        };

        send({ type: 'conversationId', conversationId: activeConvId });

        try {
          await runPipeline({
            model,
            messages,
            mode: convMode,
            workspacePath: convWorkspacePath,
            thinkingEnabled,
            searchEnabled,
            signal: ac.signal,
            onStage: (stage) => {
              currentStage = stage;
              send({ type: 'stage', stage });
            },
            onChunk: (chunk) => {
              fullResponse += chunk;
              send({ type: 'chunk', content: chunk });
            },
            userId: ownerId,
            userName,
            planningEnabled,
            temperature,
            top_p,
            max_tokens,
          });

          if (fullResponse && activeConvId && !aborted) {
            await addMessage(activeConvId, ownerId, {
              role: 'assistant',
              content: fullResponse,
            });
          }
          send({ type: 'done', stage: currentStage });

          // Async memory extraction after response is complete
          if (fullResponse && lastMessage?.role === 'user' && !aborted) {
            try {
              const memory = await getMemory(ownerId);
              if (memory.enabled) {
                const userText = lastMessage.content
                  .replace(/\[image:data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+\]/g, '[image]')
                  .trim();
                if (userText) {
                  // Fire and forget — only pass the user's message, NOT the AI's response.
                  // This prevents the AI's own hallucinations from being saved as memory.
                  extractMemoryFromTurn(ownerId, userText).catch((e) =>
                    console.error('[chat] Memory extraction error:', e)
                  );
                }
              }
            } catch (e) {
              console.error('[chat] Failed to check memory:', e);
            }
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Unknown error';
          appLogger.error('[chat] Pipeline error:', message);
          send({ type: 'error', error: message });
        } finally {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
      cancel() {
        // Client disconnected — abort the pipeline
        aborted = true;
        ac.abort();
        appLogger.info('[chat] Client disconnected, aborting pipeline');

        // Save whatever response we got
        if (fullResponse && activeConvId) {
          addMessage(activeConvId, ownerId, {
            role: 'assistant',
            content: fullResponse + ' [stopped]',
          }).catch((e) => console.error('[chat] Failed to save partial response:', e));
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (e) {
    console.error('[chat] Route error:', e);
    return c.json(
      { error: e instanceof Error ? e.message : 'Chat request failed' },
      500
    );
  }
});

// --- Title generation ---
chat.post('/title', async (c) => {
  try {
    const body = await c.req.json();
    const message: string = body.message;
    const model: string = body.model || 'qwen2.5:3b';

    if (!message) {
      return c.json({ title: 'New Chat' });
    }

    const cleaned = message
      .replace(/\[image:data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+\]/g, '[image]')
      .replace(/\[image\]/g, '')
      .trim()
      .substring(0, 200);

    if (!cleaned) {
      return c.json({ title: 'New Chat' });
    }

    let title = '';
    try {
      // Use non-streaming API for speed (#5)
      title = await ollamaChat(
        model,
        [
          {
            role: 'system',
            content: 'Generate a short, descriptive title (max 6 words, no quotes, no punctuation at end) for a conversation that starts with this message. Only output the title, nothing else.',
          },
          { role: 'user', content: cleaned },
        ],
        { temperature: 0.3, max_tokens: 20 }
      );
    } catch (e) {
      console.error('[chat] Title generation failed:', e);
    }

    const finalTitle = title
      .replace(/^["']+|["']+$/g, '')          // Remove surrounding quotes
      .replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, '')  // Strip CJK, Korean characters
      .replace(/[\-–—_*/]+/g, ' ')            // Replace underscores, dashes, asterisks with spaces
      .replace(/[^a-zA-Z0-9\s'?!,.:;@#$%&()+\[\]{}|\\]/g, '') // Only keep readable chars
      .replace(/\s+/g, ' ')                   // Collapse whitespace
      .trim()
      .substring(0, 60) || 'New Chat';

    return c.json({ title: finalTitle });
  } catch (e) {
    console.error('[chat] Title route error:', e);
    return c.json({ title: 'New Chat' });
  }
});

export default chat;
