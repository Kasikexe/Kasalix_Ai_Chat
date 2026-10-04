"""Chat routes — mirrors backend/src/routes/chat.ts (SSE streaming)."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from ..agent import get_background_processes, resolve_pending_approval, resolve_pending_question
from ..attachments import persist_data_urls, strip_image_markers
from ..deps import user_id_from_request
from ..extractor import extract_memory_from_turn
from ..logger import error as log_error, info as log_info
from ..memory import get_memory
from ..model_assignments import get_resolved_model
from ..ollama_client import StreamOptions, chat as ollama_chat
from ..pipeline import run_pipeline
from ..settings_store import get_cloud_settings
from ..storage import add_message, create_conversation, get_conversation, update_conversation
from ..models import make_message

router = APIRouter()

# Active agent/chat runs keyed by conversationId. The frontend's Stop button
# calls POST /chat/stop, which sets the matching abort event.
active_runs: dict[str, dict[str, Any]] = {}


# What counts as a CLOUD failure. This used to match "ollama error" anywhere in
# the message, so every local Ollama failure told the user "Cloud provider
# unavailable. Falling back to local models." while they were already on local
# models — a capability error like `400 ... does not support tools` on a local
# model was reported as a cloud outage. Only cloud-specific causes qualify now.
CLOUD_FAILURE_RE = re.compile(
    r"cloud|api[ _-]?key|authentication|unauthorized|ollama\.com|getaddrinfo",
    re.IGNORECASE,
)


def looks_like_cloud_failure(message: str) -> bool:
    return bool(CLOUD_FAILURE_RE.search(message or ""))


async def read_json_object(request: Request) -> dict[str, Any] | None:
    """Parse a request body that MUST be a JSON object.

    Returns None when the body is missing, malformed, or not an object
    (a wedged client can POST `null`). Callers map None to a 400 — this
    previously crashed as "'NoneType' object has no attribute 'get'" and
    returned a 500 that made the whole client look dead.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return None
    return body if isinstance(body, dict) else None


@router.get("/background-processes")
async def background_processes() -> dict:
    return {"processes": get_background_processes()}


@router.post("")
async def chat_route(request: Request) -> Any:
    conv_id: str | None = None
    conv_mode = "chat"
    conv_workspace_path: str | None = None

    try:
        owner_id = user_id_from_request(request)
        body = await read_json_object(request)
        if body is None:
            return JSONResponse({"error": "Request body must be a JSON object"}, status_code=400)
        model: str = body.get("model") or ""
        messages: list[dict[str, Any]] = body.get("messages") or []
        if not isinstance(messages, list) or not all(isinstance(m, dict) for m in messages):
            return JSONResponse({"error": "messages must be a list of objects"}, status_code=400)
        provided_conv_id: str | None = body.get("conversationId")
        thinking_enabled: bool = body.get("thinkingEnabled") is True
        thinking_mode = (
            "off"
            if body.get("thinkingMode") == "off" or (body.get("thinkingMode") is None and not thinking_enabled)
            else "auto"
        )
        mode = "agent" if body.get("mode") == "agent" else "chat"
        req_workspace_path: str | None = body.get("workspacePath")
        temperature = body.get("temperature")
        top_p = body.get("top_p")
        max_tokens = body.get("max_tokens")
        user_name = body.get("userName")
        planning_enabled: bool = body.get("planningEnabled") is True
        auto_apply: bool = body.get("autoApply") is True
        plan_mode = body.get("planMode")
        plan_mode = "on" if plan_mode == "on" else ("auto" if plan_mode == "auto" else "off")
        tool_permission = body.get("toolPermission")
        tool_permission = (
            tool_permission
            if tool_permission in ("read-only", "ask-each", "suggest", "auto-edit", "auto")
            else "auto"
        )

        if not model or not isinstance(messages, list) or not messages:
            return JSONResponse({"error": "model and messages are required"}, status_code=400)

        resume_state: dict[str, Any] | None = None
        if provided_conv_id:
            existing = await get_conversation(provided_conv_id, owner_id)
            if not existing:
                return JSONResponse({"error": "Conversation not found"}, status_code=404)
            conv_id = provided_conv_id
            conv_mode = existing.get("mode") or "chat"
            conv_workspace_path = existing.get("workspacePath") or req_workspace_path
            agent_state = existing.get("agentState")
            if existing.get("mode") == "agent" and isinstance(agent_state, dict) and agent_state.get("history"):
                resume_state = agent_state
            # First message in an agent session: agentState is None (every
            # create_conversation sets it so) — .get() on None crashed with
            # "'NoneType' object has no attribute 'get'" and killed the request
            # with a 500 before any SSE byte was sent.
        else:
            new_conv = await create_conversation(model, owner_id, None, mode, req_workspace_path)
            conv_id = new_conv["id"]
            conv_mode = mode
            conv_workspace_path = new_conv.get("workspacePath") or req_workspace_path

        last_message = messages[-1]
        if last_message.get("role") == "user" and conv_id:
            # Attached images move to disk (content-addressed) and the message
            # keeps a small [image:<filename>] reference — see app/attachments.py.
            saved_content = persist_data_urls(last_message.get("content", ""))
            await add_message(conv_id, owner_id, make_message("user", saved_content))

        active_conv_id = conv_id
        # Reject a new run while the previous one for this conversation is
        # still executing — otherwise a "stuck" agent (long thinking, churn)
        # keeps running in the background and a new message appears to be
        # ignored (the old run's output keeps streaming over it).
        existing_run = active_runs.get(conv_id)
        if existing_run and not existing_run["signal"].is_set():
            log_info("[chat] Rejected new message — previous run still executing")
            return JSONResponse({"error": "A response is still being generated for this conversation. Press stop first, then send your message."}, status_code=409)
        # Mutable state holder so the pipeline callbacks can update the
        # response accumulated so far (nonlocal reassignment isn't allowed
        # inside lambdas). Shared by the generator and save_partial.
        state = {"full_response": "", "full_thinking": "", "current_stage": "", "partial_saved": False, "sources": []}
        signal = asyncio.Event()

        if active_conv_id:
            active_runs[active_conv_id] = {"signal": signal, "ownerId": owner_id}

        last_agent_state: dict[str, Any] | None = None

        def save_partial() -> None:
            if state["partial_saved"] or not state["full_response"] or not active_conv_id:
                return
            state["partial_saved"] = True
            asyncio.create_task(
                add_message(
                    active_conv_id,
                    owner_id,
                    make_message("assistant", state["full_response"] + " [stopped]", thinking=state["full_thinking"] or None, sources=state["sources"] or None),
                )
            )

        async def stream_generator():

            queue: asyncio.Queue[str | None] = asyncio.Queue()

            def emit(data: dict[str, Any]) -> None:
                if signal.is_set():
                    return
                queue.put_nowait(f"data: {json.dumps(data, ensure_ascii=False)}\n\n")

            emit({"type": "conversationId", "conversationId": active_conv_id})

            # Keepalive: some agent rounds (slow models, long thinking) produce
            # NO output for minutes. Without these pings the client's idle
            # watchdog (120s) aborts the connection mid-run and the user sees
            # the reply "end like nothing". The client ignores unknown types.
            async def keepalive_pinger() -> None:
                while True:
                    await asyncio.sleep(20)
                    if signal.is_set():
                        return
                    queue.put_nowait("data: {\"type\": \"ping\"}\n\n")

            # Watch for client disconnect → abort the run (best effort).
            async def watch_disconnect() -> None:
                try:
                    while True:
                        await asyncio.sleep(0.5)
                        if await request.is_disconnected():
                            if not signal.is_set():
                                signal.set()
                                log_info("[chat] Client disconnected, aborting pipeline")
                                save_partial()
                            return
                except Exception:  # noqa: BLE001
                    pass

            def on_chunk(chunk: str) -> None:
                if signal.is_set():
                    return
                state["full_response"] += chunk
                emit({"type": "chunk", "content": chunk})

            def on_thinking(chunk: str) -> None:
                if signal.is_set():
                    return
                state["full_thinking"] += chunk
                emit({"type": "thinking", "content": chunk})

            def on_stage(stage: str) -> None:
                state["current_stage"] = stage
                emit({"type": "stage", "stage": stage})

            def on_metrics(metrics: dict[str, Any]) -> None:
                # Real generation stats from Ollama's final stream chunk —
                # the client turns this into the tokens/s badge.
                eval_count = int(metrics.get("eval_count") or 0)
                eval_duration_ns = int(metrics.get("eval_duration_ns") or 0)
                if eval_count > 0 and eval_duration_ns > 0:
                    emit({
                        "type": "metrics",
                        "evalCount": eval_count,
                        "evalDurationMs": round(eval_duration_ns / 1e6),
                        "tokensPerSecond": round(eval_count / (eval_duration_ns / 1e9), 1),
                    })

            def on_narration(text: str) -> None:
                if signal.is_set():
                    return
                # Model's own words between tool calls ("Now let me write the
                # movement function") — timeline event, not chat content.
                emit({"type": "narration", "content": text})

            def on_sources(sources: list[dict[str, str]]) -> None:
                # Pages the web search actually used. Kept in run state so they
                # persist with the assistant message — without that they would
                # vanish the moment the conversation is reloaded.
                if signal.is_set() or not sources:
                    return
                known = {s.get("url") for s in state["sources"]}
                for s in sources:
                    if s.get("url") and s["url"] not in known:
                        known.add(s["url"])
                        state["sources"].append({"title": s.get("title") or s["url"], "url": s["url"]})
                emit({"type": "sources", "sources": state["sources"]})

            def on_resume_state(resume: dict[str, Any]) -> None:
                nonlocal last_agent_state
                last_agent_state = resume
                if active_conv_id:
                    asyncio.create_task(
                        update_conversation(active_conv_id, owner_id, {"agentState": resume})
                    )

            # Run the pipeline as a background task so SSE chunks are yielded
            # to the client the moment they are emitted — not after generation
            # finishes. The queue is the bridge between the two.
            async def run_pipeline_task() -> None:
                try:
                    result = await run_pipeline(
                        {
                            "model": model,
                            "messages": messages,
                            "mode": conv_mode,
                            "workspacePath": conv_workspace_path,
                            "thinkingEnabled": thinking_enabled,
                            "thinkingMode": thinking_mode,
                            "signal": signal,
                            "onStage": on_stage,
                            "onChunk": on_chunk,
                            "onThinking": on_thinking,
                            "onNarration": on_narration,
                            "userId": owner_id,
                            "userName": user_name,
                            "planningEnabled": planning_enabled,
                            "autoApply": auto_apply,
                            "onAgentTool": lambda call: emit({"type": "agent_tool", "tool": call.get("tool"), "args": call.get("args")}),
                            "onToolResult": lambda r: emit({"type": "agent_tool_result", "tool": r.get("tool"), "ok": bool(r.get("ok")), "output": r.get("output")}),
                            "onFileWritten": lambda w: emit({"type": "file_written", "path": w.get("path"), "changeType": w.get("changeType"), "originalContent": w.get("originalContent")}),
                            "onAgentCommand": lambda cmd: emit({"type": "agent_command", "command": cmd.get("command"), "output": cmd.get("output"), "failed": cmd.get("failed")}),
                            "onQuestion": lambda key, q: emit({"type": "agent_question", "key": key, "question": q}),
                            "onApprovalRequest": lambda key, tool, args: emit({"type": "agent_approval_request", "key": key, "tool": tool, "args": args}),
                            "onPlan": lambda plan: emit({"type": "plan", "plan": plan}),
                            "planMode": plan_mode,
                            "onResumeState": on_resume_state,
                            "onMetrics": on_metrics,
                            "onSources": on_sources,
                            "onModelInfo": lambda m, source: emit({"type": "model_info", "model": m, "source": source}),
                            "conversationId": active_conv_id,
                            "resumeState": resume_state,
                            "temperature": temperature,
                            "top_p": top_p,
                            "max_tokens": max_tokens,
                            "toolPermission": tool_permission,
                        }
                    )

                    if state["full_response"] and active_conv_id and not signal.is_set():
                        await add_message(
                            active_conv_id,
                            owner_id,
                            make_message("assistant", state["full_response"], thinking=state["full_thinking"] or None, sources=state["sources"] or None),
                        )
                    if active_conv_id and not signal.is_set():
                        final_state = (
                            {"history": [], "pendingPlan": last_agent_state.get("pendingPlan")}
                            if last_agent_state and last_agent_state.get("pendingPlan")
                            else None
                        )
                        await update_conversation(active_conv_id, owner_id, {"agentState": final_state})
                    emit({"type": "done", "stage": state["current_stage"]})

                    # Async memory extraction after response is complete
                    if state["full_response"] and last_message.get("role") == "user" and not signal.is_set():
                        try:
                            memory = await get_memory(owner_id)
                            if memory.get("enabled"):
                                user_text = strip_image_markers(last_message.get("content", ""))
                                if user_text:
                                    asyncio.create_task(extract_memory_from_turn(owner_id, user_text))
                        except Exception as e:  # noqa: BLE001
                            log_error("[chat] Failed to check memory:", e)
                except asyncio.CancelledError:
                    if signal.is_set():
                        log_info("[chat] Pipeline aborted (stop requested)")
                        save_partial()
                    raise
                except Exception as e:  # noqa: BLE001
                    if signal.is_set():
                        log_info("[chat] Pipeline aborted (stop requested)")
                        save_partial()
                    else:
                        message = str(e) or "Unknown error"
                        log_error("[chat] Pipeline error:", message)
                        is_cloud_error = looks_like_cloud_failure(message)
                        if is_cloud_error:
                            emit({"type": "stage", "stage": "cloud:unavailable"})
                        emit({"type": "error", "error": message})
                        if active_conv_id:
                            await update_conversation(active_conv_id, owner_id, {"agentState": None})
                finally:
                    if active_conv_id:
                        active_runs.pop(active_conv_id, None)
                    watcher.cancel()
                    pinger.cancel()
                    queue.put_nowait(None)

            watcher = asyncio.create_task(watch_disconnect())
            pinger = asyncio.create_task(keepalive_pinger())
            worker = asyncio.create_task(run_pipeline_task())

            # Pump the queue while the pipeline runs concurrently
            try:
                while True:
                    item = await queue.get()
                    if item is None:
                        break
                    yield item
            finally:
                # Client disconnected or stream closed mid-run — stop the work.
                if not worker.done():
                    signal.set()
                    try:
                        await asyncio.wait_for(asyncio.shield(worker), timeout=5.0)
                    except Exception:  # noqa: BLE001
                        worker.cancel()
                watcher.cancel()
                pinger.cancel()

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    except Exception as e:  # noqa: BLE001
        log_error("[chat] Route error:", e)
        return JSONResponse({"error": str(e) or "Chat request failed"}, status_code=500)


@router.post("/stop")
async def stop(request: Request) -> dict:
    try:
        owner_id = user_id_from_request(request)
        body = await read_json_object(request)
        if body is None:
            return JSONResponse({"error": "Request body must be a JSON object"}, status_code=400)
        conversation_id = body.get("conversationId")
        if not conversation_id or not isinstance(conversation_id, str):
            return JSONResponse({"error": "conversationId is required"}, status_code=400)
        run = active_runs.get(conversation_id)
        if not run:
            return {"ok": True, "alreadyStopped": True}
        if run["ownerId"] != owner_id:
            return JSONResponse({"error": "Forbidden"}, status_code=403)
        run["signal"].set()
        active_runs.pop(conversation_id, None)
        log_info(f"[chat] Run stopped via /stop (conversation {conversation_id})")
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        log_error("[chat] Stop route error:", e)
        return JSONResponse({"error": str(e) or "Failed to stop"}, status_code=500)


@router.post("/answer")
async def answer(request: Request) -> dict:
    try:
        body = await read_json_object(request)
        if body is None:
            return JSONResponse({"error": "Request body must be a JSON object"}, status_code=400)
        key = body.get("key")
        if not key or not isinstance(key, str):
            return JSONResponse({"error": "key is required"}, status_code=400)
        answer_text = body.get("answer")
        ok = resolve_pending_question(key, answer_text[:2000] if isinstance(answer_text, str) else "")
        if not ok:
            return JSONResponse({"error": "No pending question for that key"}, status_code=404)
        return {"success": True}
    except Exception as e:  # noqa: BLE001
        log_error("[chat] Answer route error:", e)
        return JSONResponse({"error": str(e) or "Failed to answer"}, status_code=500)


@router.post("/approve")
async def approve(request: Request) -> dict:
    try:
        body = await read_json_object(request)
        if body is None:
            return JSONResponse({"error": "Request body must be a JSON object"}, status_code=400)
        key = body.get("key")
        if not key or not isinstance(key, str):
            return JSONResponse({"error": "key is required"}, status_code=400)
        ok = resolve_pending_approval(key, body.get("approved") is True)
        if not ok:
            return JSONResponse({"error": "No pending approval for that key"}, status_code=404)
        return {"success": True}
    except Exception as e:  # noqa: BLE001
        log_error("[chat] Approve route error:", e)
        return JSONResponse({"error": str(e) or "Failed"}, status_code=500)


@router.post("/title")
async def title(request: Request) -> dict:
    try:
        body = await read_json_object(request)
        if body is None:
            return JSONResponse({"error": "Request body must be a JSON object"}, status_code=400)
        message = body.get("message")
        if not message:
            return {"title": "New Chat"}
        cleaned = strip_image_markers(message)[:200]
        if not cleaned:
            return {"title": "New Chat"}

        title_text = ""
        try:
            resolved = await get_resolved_model("chat")
            title_model = resolved["model"]
            title_source = resolved["source"]
            cloud_settings = await get_cloud_settings() if title_source == "cloud" else None
            log_info(f"[chat/title] Model: {title_model} (source: {title_source})")
            title_text = await ollama_chat(
                title_model,
                [
                    {
                        "role": "system",
                        "content": "Generate a short, descriptive title (max 6 words, no quotes, no punctuation at end) for a conversation that starts with this message. Only output the title, nothing else.",
                    },
                    {"role": "user", "content": cleaned},
                ],
                StreamOptions(
                    temperature=0.3,
                    max_tokens=20,
                    base_url=(cloud_settings or {}).get("cloudEndpoint") or None,
                    api_key=(cloud_settings or {}).get("cloudApiKey") or None,
                ),
            )
        except Exception as e:  # noqa: BLE001
            log_error("[chat] Title generation failed:", e)

        final_title = (
            title_text
            .strip()
            .strip('"\'')
            .replace("_", " ")
            .replace("-", " ")
            .replace("—", " ")
            .replace("–", " ")
            .replace("*", " ")
            .replace("/", " ")
            .replace("\\", " ")
        )
        # Keep only readable characters (mirrors the TS regex approach)
        final_title = re.sub(r"[^a-zA-Z0-9\s'?!,.:;@#$%&()+\[\]{}|]", " ", final_title)
        final_title = re.sub(r"\s+", " ", final_title).strip()[:60] or "New Chat"
        return {"title": final_title}
    except Exception as e:  # noqa: BLE001
        log_error("[chat] Title route error:", e)
        return {"title": "New Chat"}