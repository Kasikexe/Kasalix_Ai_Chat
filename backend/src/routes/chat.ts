import { Hono } from 'hono';
import { runPipeline } from '../services/pipeline';
import { addMessage, createConversation, getConversation } from '../services/storage';
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
    const mode: ConversationMode = body.mode === 'agent' ? 'agent' : 'chat';
    const reqWorkspacePath: string | undefined = body.workspacePath;

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
            signal: ac.signal,
            onStage: (stage) => {
              currentStage = stage;
              send({ type: 'stage', stage });
            },
            onChunk: (chunk) => {
              fullResponse += chunk;
              send({ type: 'chunk', content: chunk });
            },
          });

          if (fullResponse && activeConvId && !aborted) {
            await addMessage(activeConvId, ownerId, {
              role: 'assistant',
              content: fullResponse,
            });
          }
          send({ type: 'done', stage: currentStage });
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Unknown error';
          console.error('[chat] Pipeline error:', message);
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
        console.log('[chat] Client disconnected, aborting pipeline');

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

export default chat;
