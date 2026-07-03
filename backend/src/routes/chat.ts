import { Hono } from 'hono';
import { streamChat } from '../services/ollama';
import { addMessage, createConversation, getConversation } from '../services/storage';
import type { Message, Variables } from '../types';

const chat = new Hono<{ Variables: Variables }>();

chat.post('/', async (c) => {
  let convId: string | undefined;

  try {
    const ownerId = c.get('user').id;
    const body = await c.req.json();
    const model: string = body.model;
    const messages: Message[] = body.messages;
    const providedConvId: string | undefined = body.conversationId;

    if (!model || !Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: 'model and messages are required' }, 400);
    }

    if (providedConvId) {
      const existing = await getConversation(providedConvId, ownerId);
      if (!existing) return c.json({ error: 'Conversation not found' }, 404);
      convId = providedConvId;
    } else {
      const newConv = await createConversation(model, ownerId);
      convId = newConv.id;
    }

    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role === 'user' && convId) {
      await addMessage(convId, ownerId, lastMessage);
    }

    const encoder = new TextEncoder();
    let fullResponse = '';
    let aborted = false;
    const activeConvId = convId;

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
          await streamChat(
            model,
            messages,
            (chunk) => {
              fullResponse += chunk;
              send({ type: 'chunk', content: chunk });
            }
          );

          if (fullResponse && activeConvId) {
            await addMessage(activeConvId, ownerId, { role: 'assistant', content: fullResponse });
          }
          send({ type: 'done' });
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Unknown error';
          send({ type: 'error', error: message });
        } finally {
          try { controller.close(); } catch { /* noop */ }
        }
      },
      cancel() {
        aborted = true;
        if (fullResponse && activeConvId) {
          addMessage(activeConvId, ownerId, { role: 'assistant', content: fullResponse }).catch(() => {});
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
    return c.json({ error: e instanceof Error ? e.message : 'Chat request failed' }, 500);
  }
});

export default chat;
