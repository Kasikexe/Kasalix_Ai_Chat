import { Hono } from 'hono';
import { runPipeline } from '../services/pipeline';
import { addMessage, createConversation, getConversation, updateConversation } from '../services/storage';
import { resolvePendingQuestion } from '../services/agent';
import { getMemory } from '../services/memory';
import { extractMemoryFromTurn } from '../services/extractor';
import { chat as ollamaChat, streamChat } from '../services/ollama';
import { logger as appLogger } from '../services/logger';
import type { ConversationMode, Message } from '../types';

const chat = new Hono();

// Active agent/chat runs keyed by conversationId. The frontend's Stop button
// calls POST /chat/stop, which aborts the matching controller — this is the
// reliable stop mechanism (client-disconnect detection is flaky in
// @hono/node-server when the POST body has been read).
const activeRuns = new Map<string, { controller: AbortController; ownerId: string }>();

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
    // 'auto' (default): adaptive — thinking activates only when a message needs
    // reasoning. 'off': never think. Old clients send thinkingEnabled instead.
    const thinkingMode: 'auto' | 'off' =
      body.thinkingMode === 'off' || (body.thinkingMode === undefined && !thinkingEnabled) ? 'off' : 'auto';
    const mode: ConversationMode = body.mode === 'agent' ? 'agent' : 'chat';
    const reqWorkspacePath: string | undefined = body.workspacePath;
    const temperature: number | undefined = body.temperature;
    const top_p: number | undefined = body.top_p;
    const max_tokens: number | undefined = body.max_tokens;
    const userName: string | undefined = body.userName;
    const planningEnabled: boolean = body.planningEnabled === true;
    const autoApply: boolean = body.autoApply === true;

    if (!model || !Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: 'model and messages are required' }, 400);
    }

    // Create or fetch conversation
    let resumeState: { history: { role: string; content: string }[] } | undefined;
    if (providedConvId) {
      const existing = await getConversation(providedConvId, ownerId);
      if (!existing) return c.json({ error: 'Conversation not found' }, 404);
      convId = providedConvId;
      convMode = existing.mode || 'chat';
      convWorkspacePath = existing.workspacePath || reqWorkspacePath;
      // If a previous agent run was stopped/capped, resume it with the next message.
      if (existing.mode === 'agent' && existing.agentState?.history?.length) {
        resumeState = existing.agentState;
      }
    } else {
      // New conversation: persist the workspace the frontend sent so the FIRST
      // agent message (and any resume) has the same files to read. Previously
      // the workspace was dropped here, so the first run had no folder and the
      // agent said it couldn't read any files.
      const newConv = await createConversation(model, ownerId, undefined, mode, reqWorkspacePath);
      convId = newConv.id;
      convMode = mode;
      convWorkspacePath = newConv.workspacePath || reqWorkspacePath;
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
    let fullThinking = '';
    let currentStage = '';

    // Abort controller for this run. Stopped via POST /chat/stop (the Stop
    // button) or best-effort client-disconnect listeners below.
    const ac = new AbortController();
    // Register the run so the Stop button (POST /chat/stop) can abort it.
    if (activeConvId) {
      activeRuns.set(activeConvId, { controller: ac, ownerId });
    }

    let partialSaved = false;
    const savePartial = () => {
      if (partialSaved || !fullResponse || !activeConvId) return;
      partialSaved = true;
      addMessage(activeConvId, ownerId, {
        role: 'assistant',
        content: fullResponse + ' [stopped]',
        thinking: fullThinking || undefined,
      }).catch((e) => console.error('[chat] Failed to save partial response:', e));
    };
    const onClientAbort = () => {
      if (ac.signal.aborted) return;
      aborted = true;
      ac.abort();
      appLogger.info('[chat] Client disconnected, aborting pipeline');
      // Save whatever response we got so the user sees the partial result.
      savePartial();
    };
    c.req.raw.signal.addEventListener('abort', onClientAbort, { once: true });
    // @hono/node-server: the request's Fetch signal is NOT aborted on client
    // disconnect — only the underlying Node IncomingMessage close is. Listen
    // for it so a dropped connection actually stops the pipeline.
    const nodeIncoming = (c.env as any)?.incoming as
      | { on?: (ev: string, fn: () => void) => void; aborted?: boolean }
      | undefined;
    if (nodeIncoming?.on) {
      // Best-effort: fires when the socket actually closes (works for GET-like
      // flows, but not reliably for body-reading POSTs — the /stop route is
      // the dependable path).
      nodeIncoming.on('close', onClientAbort);
      nodeIncoming.on('aborted', onClientAbort);
    }

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
            thinkingMode,
            signal: ac.signal,
            onStage: (stage) => {
              currentStage = stage;
              send({ type: 'stage', stage });
            },
            onChunk: (chunk) => {
              fullResponse += chunk;
              send({ type: 'chunk', content: chunk });
            },
            onThinking: (chunk) => {
              fullThinking += chunk;
              send({ type: 'thinking', content: chunk });
            },
            userId: ownerId,
            userName,
            planningEnabled,
            autoApply,
            onAgentTool: (call) => send({ type: 'agent_tool', tool: call.tool, args: call.args }),
            onFileWritten: (write) => send({ type: 'file_written', path: write.path, changeType: write.changeType, originalContent: write.originalContent }),
            onAgentCommand: (cmd) => send({ type: 'agent_command', command: cmd.command, output: cmd.output, failed: cmd.failed }),
            onQuestion: (key, question) => send({ type: 'agent_question', key, question }),
            onResumeState: (state) => {
              if (activeConvId) {
                updateConversation(activeConvId, ownerId, { agentState: state }).catch((e) =>
                  console.error('[chat] Failed to save agent resume state:', e)
                );
              }
            },
            conversationId: activeConvId,
            resumeState,
            temperature,
            top_p,
            max_tokens,
          });

          if (fullResponse && activeConvId && !aborted) {
            await addMessage(activeConvId, ownerId, {
              role: 'assistant',
              content: fullResponse,
              thinking: fullThinking || undefined,
            });
          }
          // The run finished without being stopped — clear any saved resume state
          // so a future message starts fresh instead of re-resuming.
          if (activeConvId && !aborted) {
            updateConversation(activeConvId, ownerId, { agentState: null }).catch(() => {});
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
          // Stopped via the Stop button or client disconnect — keep the resume
          // state (the agent loop persists it via onResumeState) and record the
          // partial response. Only real failures clear resume state.
          if (ac.signal.aborted) {
            aborted = true;
            appLogger.info('[chat] Pipeline aborted (stop requested)');
            savePartial();
          } else {
            const message = e instanceof Error ? e.message : 'Unknown error';
            appLogger.error('[chat] Pipeline error:', message);
            send({ type: 'error', error: message });
            // Non-abort failures end the run — don't leave stale resume state behind.
            if (activeConvId) {
              updateConversation(activeConvId, ownerId, { agentState: null }).catch(() => {});
            }
          }
        } finally {
          // Run finished or was stopped — remove it from the stop registry.
          if (activeConvId) activeRuns.delete(activeConvId);
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
      cancel() {
        // Client disconnected — abort the pipeline (mirrors onClientAbort)
        onClientAbort();
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

// --- Stop an active run (Stop button) ---
// The frontend aborts its fetch AND calls this so the server actually stops
// the pipeline and persists resume state. Reliable even though HTTP
// disconnect detection is flaky for body-reading POSTs.
chat.post('/stop', async (c) => {
  try {
    const ownerId = c.get('user').id;
    const { conversationId } = await c.req.json();
    if (!conversationId || typeof conversationId !== 'string') {
      return c.json({ error: 'conversationId is required' }, 400);
    }
    const run = activeRuns.get(conversationId);
    if (!run) {
      return c.json({ ok: true, alreadyStopped: true });
    }
    if (run.ownerId !== ownerId) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    run.controller.abort();
    activeRuns.delete(conversationId);
    appLogger.info(`[chat] Run stopped via /stop (conversation ${conversationId})`);
    return c.json({ ok: true });
  } catch (e) {
    console.error('[chat] Stop route error:', e);
    return c.json({ error: e instanceof Error ? e.message : 'Failed to stop' }, 500);
  }
});

// --- Agent ask_user answers ---
chat.post('/answer', async (c) => {
  try {
    const { key, answer } = await c.req.json();
    if (!key || typeof key !== 'string') {
      return c.json({ error: 'key is required' }, 400);
    }
    const ok = resolvePendingQuestion(key, typeof answer === 'string' ? answer.slice(0, 2000) : '');
    if (!ok) return c.json({ error: 'No pending question for that key' }, 404);
    return c.json({ success: true });
  } catch (e) {
    console.error('[chat] Answer route error:', e);
    return c.json({ error: e instanceof Error ? e.message : 'Failed to answer' }, 500);
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
