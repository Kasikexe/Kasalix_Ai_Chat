"""Chat pipeline — mirrors backend/src/services/pipeline.ts.

The orchestrator: intent detection, dangerous-request guard, cloud routing,
adaptive thinking, web-search/file/memory context gathering, the model-driven
tool loop (web_search + draw_image in chat), the guaranteed draw-image path,
agent (Koding) branching, and the vision → planning → code → summary pipeline.
"""

from __future__ import annotations

import asyncio
import contextvars
import re
import time
from typing import Any, Callable

import httpx

from .ai_rules import with_ai_rules
from .attachments import image_data_urls, strip_image_markers
from .cloud_auth import verify_cloud_key
from .content_guard import DANGEROUS_REPLY, find_dangerous_request
from .imagegen import sanitize_svg, save_artwork
from .logger import error as log_error, info as log_info, warn as log_warn
from .memory import get_memory
from .model_assignments import get_model_assignment, get_resolved_model
from .ollama_client import OllamaError, StreamOptions, get_models, stream_chat, stream_chat_with_tools
from .search import get_web_context, set_source_sink
from .settings_store import get_cloud_settings
from .tools import detect_tool, execute_tool, get_all_tools, is_probably_math_expression
from .models import Message

# Cloud routing state — resolved once per pipeline run. Contextvars keep
# concurrent conversations from clobbering each other's endpoint.
_cloud_endpoint: contextvars.ContextVar[str] = contextvars.ContextVar("cloud_endpoint", default="")
_cloud_api_key: contextvars.ContextVar[str] = contextvars.ContextVar("cloud_api_key", default="")


def _estimate_tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)


async def _track_cloud_usage(model_name: str, input_tokens: int | None = None, output_tokens: int | None = None) -> None:
    """Increment cloud usage counter (fire-and-forget, never blocks)."""
    import os

    try:
        total = (input_tokens or 0) + (output_tokens or 0)
        port = os.environ.get("PORT") or "3001"
        async with httpx.AsyncClient(timeout=3.0) as client:
            res = await client.post(
                f"http://localhost:{port}/api/cloud-usage/increment",
                headers={"Content-Type": "application/json", "Cookie": "settings_auth=1"},
                json={
                    "model": model_name,
                    "tokens": total,
                    "inputTokens": input_tokens or 0,
                    "outputTokens": output_tokens or 0,
                },
            )
        if res.status_code < 400:
            usage = res.json()
            monthly = usage.get("monthlyLimit") or 0
            total_req = usage.get("totalRequests") or 0
            if monthly > 0 and total_req >= monthly * 0.9:
                log_warn(f"[cloud-usage] Approaching monthly limit: {total_req}/{monthly}")
    except Exception:  # noqa: BLE001
        pass  # Usage tracking is best-effort


# ─── Context gathering ──────────────────────────────────────
LIST_IGNORE_DIRS = {
    "node_modules", ".git", ".svn", ".hg", ".DS_Store",
    "__pycache__", ".next", ".nuxt", "dist", "build", ".cache",
    "target", "vendor", ".venv", "venv", "env",
    # Server internals — the agent must never see or touch these
    "backend", ".freebuff", "certs", "server-gui", "release",
}


def needs_web_search(user_message: str) -> bool:
    """Smart heuristic: skip greetings, acknowledgments, conversational
    follow-ups, and self-referential questions; run for explicit searches and
    time-sensitive / external-factual queries."""
    trimmed = user_message.strip()
    if not trimmed:
        return False
    lower = trimmed.lower()

    short_ack = re.compile(
        r"^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|yeah|sure|great|nice|cool|good|lol|haha|awesome|perfect|got it|i see|understood|makes sense|indeed|right|of course|bye|goodbye)$",
        re.IGNORECASE,
    )
    if short_ack.match(lower):
        return False

    conv_followup = re.compile(
        r"(tell me more|continue|go on|what else|can you elaborate|can you explain further|that makes sense|good point|i agree|you('| a)re right|fair enough)",
        re.IGNORECASE,
    )
    if conv_followup.search(lower):
        return False

    self_referential = (
        re.search(r"\bam i\b", lower, re.IGNORECASE)
        or re.search(r"\bdo you think\b.*\b(i'?m|i am|we|my|me)\b", lower, re.IGNORECASE)
        or re.search(r"\brate\b.*\b(my|me)\b", lower, re.IGNORECASE)
        or re.search(r"\bhow do i look\b", lower, re.IGNORECASE)
        or re.search(r"\bhow (?:big|small|long|tall|old|good|bad|attractive|pretty|handsome|smart) (?:am i|is my)\b", lower, re.IGNORECASE)
        or re.search(r"\bis my\b.*\b(big|small|long|tall|good|bad|attractive|pretty|handsome|smart|nice|ok|okay|normal|weird|fine)\b", lower, re.IGNORECASE)
    )
    if self_referential:
        return False

    explicit = re.search(
        r"\b(search(?:\s+up)?|look\s*up|look\s+(?:it|that|this|them|those)\s+up|"
        r"find\s*(?:me)?|google(?:\s+it)?|look\s*into|research|"
        r"check\s*(?:online|the\s*web|internet)|"
        r"what(?:'s| is| are) (?:on|in|about|the latest)|tell me about)\b",
        lower,
        re.IGNORECASE,
    )
    if explicit:
        # Honoured at ANY length. "search it up" is 12 characters, so it used
        # to fall through the length gate below and the follow-up silently
        # never searched at all.
        return True

    if len(trimmed) < 15:
        return False

    factual = re.search(
        r"\b(current|latest|recent|news|update|today'?s|tonight|tomorrow|yesterday|population|weather|price|cost|distance|temperature|forecast|schedule|deadline|release|announcement|election|president|ceo|founder|invented|discovered|stock|rate|gdp|salary|rank|record|statistic|index|benchmark)\b",
        lower,
        re.IGNORECASE,
    )
    time_word = re.search(
        r"\b(now|right now|currently|as of|in \d{4}|this (?:year|month|week|day)|last (?:year|month|week))\b",
        lower,
        re.IGNORECASE,
    )
    return bool(factual or time_word)


# ─── Search subject resolution ──────────────────────────────────────────────
# The trigger and the query used to be the same string: the raw message. That
# broke follow-ups in both directions — "can you search it up for me" was sent
# to the search engine verbatim (words like "can you" and "for me" included),
# while "search it up" was too short to search at all. A message now yields a
# SUBJECT: command words and politeness are stripped, and when nothing but a
# reference is left ("it", "that", "the same thing") the subject is borrowed
# from the earlier turn that reference points at.

_FRAMING_PREFIX_RE = re.compile(
    r"^(?:(?:hey|hi|hello|ok|okay|so|now|well|please|pls|just|actually|also|and|but|umm|uh)[\s,]+)*"
    r"(?:(?:can|could|would|will|do)\s+(?:you|u)\s+(?:please\s+|kindly\s+)?|"
    r"i\s+(?:want|need|'?d\s+like)\s+(?:you\s+)?to\s+|"
    r"go\s+ahead\s+and\s+|try\s+to\s+)*",
    re.IGNORECASE,
)

# Only stripped at the START of a message. Mid-sentence "search" is a topic
# word ("how does a binary search work") and must survive untouched. So must a
# bare verb directly in front of a noun — "search algorithms explained" and
# "google maps vs apple maps" are topics, not commands, so those forms require a
# determiner, preposition or pronoun after the verb (lookaheads below).
_COMMAND_PREFIX_RE = re.compile(
    r"^(?:"
    r"search\s+(?:the\s+)?(?:web|internet|online)\s+for\s+|"
    r"search\s+(?:it|that|this|them|those)\s*up\b\s*|"
    r"search\s*up\s+|"
    r"search\s+for\s+|"
    r"search\s+(?=(?:the|it|that|this|them|those|about)\b)|"
    r"google\s+it\b\s*|"
    r"google\s+for\s+|"
    r"google\s+(?=(?:the|it|that|this|them|those)\b)|"
    r"look\s+(?:it|that|this|them|those)\s+up\b\s*|"
    r"look\s+up\s+|"
    r"look\s+into\s+|"
    r"find\s+(?:me\s+|us\s+|out\s+)?|"
    r"research\s+(?=(?:the|it|that|this|them|those|about)\b)|"
    r"check\s+(?:online|the\s+web|the\s+internet)\s*(?:for\s+)?"
    r")",
    re.IGNORECASE,
)

# Left over after a command is removed: "search for me the population of X"
# leaves "me the population of X". Only ever applied to a message that had a
# command in it, so a query legitimately starting with "me" is untouched.
_LEADING_FILLER_RE = re.compile(r"^(?:for\s+)?(?:me|us)\b[\s,]*", re.IGNORECASE)

_TRAILING_NOISE_RE = re.compile(
    r"(?:\s*[,.]?\s*(?:please|pls|thanks|thank\s+you|for\s+me|for\s+us|real\s+quick|"
    r"right\s+now|now|online|on\s+the\s+web|on\s+the\s+internet|if\s+you\s+can|"
    r"for\s+me\s+please))+$",
    re.IGNORECASE,
)

# Nothing but a pointer at something already said — searching these words
# verbatim is exactly the "search it up" failure.
_REFERENCE_ONLY_RE = re.compile(
    r"^(?:it|that|this|them|those|these|him|her|its|"
    r"(?:it|that|this|them|those)\s+up|"
    r"the\s+(?:thing|stuff|above|topic|subject|previous\s+one|same(?:\s+thing)?)|"
    r"that\s+(?:thing|stuff)|"
    r"more(?:\s+(?:info|information|details))?|same|again)\s*[.!?]*$",
    re.IGNORECASE,
)


def _plain_text(content: str) -> str:
    return strip_image_markers(content or "").strip()


def strip_search_command(message: str) -> str:
    """Remove framing and search commands from the front, noise from the back."""
    text = _plain_text(message)
    previous = None
    while previous != text:
        previous = text
        text = _FRAMING_PREFIX_RE.sub("", text).strip()
        stripped = _COMMAND_PREFIX_RE.sub("", text).strip()
        if stripped != text:
            text = stripped
            text = _LEADING_FILLER_RE.sub("", text).strip()
    previous = None
    while previous != text:
        previous = text
        text = _TRAILING_NOISE_RE.sub("", text).strip(" ,.")
    # Stray punctuation often survives a command removal ("search it up?");
    # a query never needs to start or end with it.
    return text.strip(" \t\r\n,.:;?!-\u2013\u2014\u2026")


def extract_search_topic(message: str) -> str | None:
    """The searchable subject of a message, or None when it has none of its own."""
    text = strip_search_command(message)
    if not text or _REFERENCE_ONLY_RE.match(text):
        return None
    return text


def previous_topic(history: list[Message] | None, current: str) -> str | None:
    """The subject an earlier turn was about — what "it" points at.

    Only user messages are considered: an assistant reply is long, may be a
    refusal, and is a summary of the topic rather than the topic. Reference-only
    turns are skipped so "search it up" after another "search it up" still finds
    the real subject instead of borrowing a command.
    """
    skipped_current = False
    for message in reversed(list(history or [])):
        if message.get("role") != "user":
            continue
        text = _plain_text(message.get("content", ""))
        if not skipped_current and text == current:
            skipped_current = True
            continue
        topic = extract_search_topic(text)
        if topic:
            return topic
    return None


def resolve_search_query(message: str, history: list[Message] | None = None) -> str | None:
    """What to actually search for, or None to answer without searching.

    Triggered by needs_web_search on the raw message; the query is then the
    message's own subject, or the earlier turn it refers back to.
    """
    current = _plain_text(message)
    if not current or not needs_web_search(current):
        return None
    topic = extract_search_topic(current)
    if topic:
        return topic
    return previous_topic(history, current)


def needs_thinking(user_message: str) -> bool:
    """Adaptive thinking heuristic — mirrors the TS export."""
    text = re.sub(r"\[image:[^\]]+\]", "", user_message or "").strip()
    if not text or len(text) < 4:
        return False
    lower = text.lower()

    ack = re.compile(
        r"^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|yeah|nope|sure|great|cool|good|lol|haha|awesome|perfect|nice|bye|goodbye|alright|got it|understood|makes sense|thanks a lot)$",
        re.IGNORECASE,
    )
    if ack.match(lower):
        return False

    math_vocab = re.search(
        r"\b(calculate|compute|solve|equation|algebra|geometry|probability|statistics?|percentage|fraction|derivative|integral)\b", lower
    )
    expr_candidate = re.sub(r"^(calculate|what (?:is|'s)|compute|solve|evaluate)\s+", "", text, flags=re.IGNORECASE).strip()
    if math_vocab or is_probably_math_expression(expr_candidate):
        return True

    reasoning = re.compile(
        r"\b(analy[sz]e|compare|contrast|explain why|prove|deduce|derive|predict|justify|logic|puzzle|hypothes|evaluate|interpret|implications|consequences|trade-offs?|pros and cons|should (i|you|we)|is it (better|worse|ethical|fair|correct)|what would happen|how (would|can|should)|why (is|are|does|do|would|should))\b"
    )
    if reasoning.search(lower):
        return True

    if re.search(r"\bwhich\b.*\b(better|worse|best|cheaper|faster|stronger|more reliable)\b", text, re.IGNORECASE):
        return True

    question_count = text.count("?")
    if question_count >= 2:
        return True
    if len(text) > 100 and question_count >= 1:
        return True

    return False


async def list_workspace_files(ws_path: str) -> str:
    import os

    try:
        resolved = os.path.abspath(ws_path)
        if not os.path.isdir(resolved):
            return ""
        entries = sorted(os.listdir(resolved))
        entries = [e for e in entries if not e.startswith(".") and e not in LIST_IGNORE_DIRS]
        lines: list[str] = []
        for entry in entries:
            full = os.path.join(resolved, entry)
            if os.path.isdir(full):
                lines.append(f"  \U0001f4c1 {entry}/")
            else:
                try:
                    size = os.path.getsize(full)
                    size_str = f" ({size}B)" if size < 1024 else f" ({size / 1024:.1f}KB)"
                except OSError:
                    size_str = ""
                lines.append(f"  \U0001f4c4 {entry}{size_str}")
        if not lines:
            return "  (empty directory)"
        return "\n".join(lines)
    except OSError:
        return ""


async def detect_intent(messages: list[Message], mode: str | None = None) -> dict[str, Any]:
    last = messages[-1] if messages else None
    if last is None or last.get("role") != "user":
        return {"hasImage": False, "wantsCode": False, "wantsFileInfo": False, "wantsTool": False}

    raw_content = last.get("content", "")
    content = raw_content.lower()
    # Resolves both an inline data URL and a stored [image:<filename>]
    # reference, so a regenerated or re-sent image keeps its image-ness.
    image_urls = image_data_urls(raw_content)
    has_image = bool(image_urls)

    tool_match = await detect_tool(last.get("content", ""))
    wants_tool = tool_match is not None
    tool_id = tool_match["toolId"] if tool_match else None
    tool_params = tool_match["params"] if tool_match else None

    file_query_phrases = [
        "what files", "list files", "show files", "tell me what files",
        "what is in", "what is inside", "what's in", "what's inside",
        "files in this directory", "files in this folder",
        "list directory", "show directory", "directory contents",
        "how many files", "what do you see", "what do you have",
        "files are there", "files are here", "files exist",
        "show me the files", "tell me the files",
    ]
    wants_file_info = any(p in content for p in file_query_phrases)

    agent_code_phrases = [
        "write a", "write an", "write the", "write code", "write a function",
        "write a script", "write a program", "write a component", "write a file",
        "generate a", "generate an", "generate code", "generate a function",
        "generate a component", "create a", "create an", "create code",
        "create a function", "create a script", "create a component",
        "create a file", "create a page", "build a", "build an",
        "build a website", "build an app", "build a page", "build a component",
        "build a project", "make a", "make an", "make a website",
        "make an app", "make a page", "make a component", "make a file",
        "implement a", "implement an", "implement this", "implement the",
        "add a", "add an", "add the", "add code", "add a function",
        "add a component", "add a file", "add a button", "add a page",
        "update the", "update my", "edit the", "edit my", "change the",
        "modify the", "fix the", "fix this", "fix my", "fix a bug", "debug",
        "refactor", "rewrite", "convert to", "convert this", "turn this into",
        "turn it into", "remake this", "recreate this", "code this",
        "html page", "css code", "web page", "website",
        "in html", "in css", "in javascript", "in python", "in typescript",
        "in react", "in vue", "in go", "in rust", "in java",
        "the code", "my code", "this code", "some code", "a function",
        "a script", "a component", "a class", "a file", "a page", "a button",
        "a modal", "a form", "a menu", "a header", "a footer", "a navbar",
        "a database", "an api", "a style", "a layout", "a template",
        "typescript", "javascript", "python", "react", "vue", "html", "css", "sql",
    ]

    code_verbs = [
        "add", "create", "build", "make", "write", "generate", "fix", "update",
        "remove", "delete", "implement", "change", "modify", "convert", "turn",
        "refactor", "rewrite", "style", "code", "debug", "edit",
    ]
    code_nouns = [
        "app", "website", "web", "page", "button", "form", "component",
        "function", "file", "style", "theme", "layout", "header", "footer",
        "modal", "menu", "navbar", "nav", "database", "api", "ui", "interface",
        "template", "script", "program", "project", "class", "todo", "dark mode",
    ]
    has_verb = any(v in content for v in code_verbs)
    has_noun = any(n in content for n in code_nouns)

    code_phrases = [
        "write code", "write a function", "write a script", "write a program",
        "generate code", "create a function", "create a script",
        "build a website", "build an app", "build a page",
        "code this", "implement this", "remake this", "recreate this",
        "convert to html", "convert to css", "convert to javascript",
        "turn this into code", "turn this into html", "turn this into a website",
        "make this into", "make it into", "in html", "in css", "in javascript",
        "in python", "in typescript", "in react", "in vue",
        "show me the code", "give me the code", "html page", "css code",
    ]

    if mode == "agent":
        wants_code = any(p in content for p in agent_code_phrases) or (has_verb and has_noun)
    else:
        wants_code = any(p in content for p in code_phrases)

    image_data_url: str | None = image_urls[0] if image_urls else None

    return {
        "hasImage": has_image,
        "wantsCode": wants_code,
        "wantsFileInfo": wants_file_info,
        "wantsTool": wants_tool,
        "toolId": tool_id,
        "toolParams": tool_params,
        "imageDataUrl": image_data_url,
    }


def _check_abort(signal: asyncio.Event | None) -> None:
    if signal is not None and signal.is_set():
        raise asyncio.CancelledError()


# ─── Stage runners ──────────────────────────────────────────
async def run_internal_stage(
    stage_name: str,
    model: str,
    messages: list[Message],
    think: bool,
    signal: asyncio.Event | None = None,
    extra_opts: dict[str, Any] | None = None,
    on_thinking: Callable[[str], None] | None = None,
    on_stage: Callable[[str], None] | None = None,
) -> str:
    """Internal stage: runs the model without streaming output to the user."""
    log_info(f'[pipeline] Internal stage "{stage_name}" — model: {model}, think: {think}')
    output: list[str] = []
    first_chunk = False

    def chunk_cb(chunk: str) -> None:
        nonlocal first_chunk
        first_chunk = True
        output.append(chunk)

    await stream_chat(
        model,
        messages,
        chunk_cb,
        StreamOptions(
            signal=signal,
            think=think,
            on_thinking=on_thinking,
            base_url=_cloud_endpoint.get() or None,
            api_key=_cloud_api_key.get() or None,
            temperature=(extra_opts or {}).get("temperature"),
            top_p=(extra_opts or {}).get("top_p"),
            max_tokens=(extra_opts or {}).get("max_tokens"),
        ),
    )
    log_info(f'[pipeline] Stage "{stage_name}" done. Length: {len("".join(output))}')
    return "".join(output)


async def run_visible_stage(
    stage_name: str,
    model: str,
    messages: list[Message],
    think: bool,
    on_chunk: Callable[[str], None],
    signal: asyncio.Event | None = None,
    extra_opts: dict[str, Any] | None = None,
    on_thinking: Callable[[str], None] | None = None,
    on_metrics: Callable[[dict[str, int]], None] | None = None,
) -> str:
    """Visible stage: streams output to the user."""
    log_info(f'[pipeline] Visible stage "{stage_name}" — model: {model}, think: {think}')
    output: list[str] = []

    def chunk_cb(chunk: str) -> None:
        output.append(chunk)
        on_chunk(chunk)

    await stream_chat(
        model,
        messages,
        chunk_cb,
        StreamOptions(
            signal=signal,
            think=think,
            on_thinking=on_thinking,
            base_url=_cloud_endpoint.get() or None,
            api_key=_cloud_api_key.get() or None,
            temperature=(extra_opts or {}).get("temperature"),
            top_p=(extra_opts or {}).get("top_p"),
            max_tokens=(extra_opts or {}).get("max_tokens"),
            on_metrics=on_metrics,
        ),
    )
    log_info(f'[pipeline] Stage "{stage_name}" done. Length: {len("".join(output))}')
    return "".join(output)


# ─── Model-driven tool calling ──────────────────────────────
MAX_TOOL_ROUNDS = 4
CHAT_TOOL_IDS = {"web_search", "draw_image"}


def to_ollama_tools() -> list[dict[str, Any]]:
    tools: list[dict[str, Any]] = []
    for t in get_all_tools():
        required = [p.name for p in t.params if p.required]
        schema: dict[str, Any] = {
            "type": "function",
            "function": {
                "name": t.id,
                "description": t.description,
                "parameters": {
                    "type": "object",
                    "properties": {p.name: {"type": p.type, "description": p.description} for p in t.params},
                },
            },
        }
        if required:
            schema["function"]["required"] = required
        tools.append(schema)
    return tools


def to_chat_tools() -> list[dict[str, Any]]:
    return [t for t in to_ollama_tools() if t.get("function", {}).get("name") in CHAT_TOOL_IDS]


def embed_generated_images(content: str, filenames: list[str], on_chunk: Callable[[str], None]) -> str:
    out = content
    appended = ""
    for filename in filenames:
        ref = f"/api/generated/{filename}"
        if ref in out:
            continue
        image = f"![Generated image]({ref})"
        appended += ("\n\n" if (out or appended) else "") + image
        out = f"{out}\n\n{image}" if out else image
    if appended:
        on_chunk(appended)
    return out


async def run_chat_tool_loop(
    stage_name: str,
    model: str,
    messages: list[Message],
    think: bool,
    on_chunk: Callable[[str], None],
    signal: asyncio.Event | None = None,
    extra_opts: dict[str, Any] | None = None,
    on_thinking: Callable[[str], None] | None = None,
    on_stage: Callable[[str], None] | None = None,
    tools_override: list[dict[str, Any]] | None = None,
    on_metrics: Callable[[dict[str, Any]], None] | None = None,
) -> str:
    """Run a chat turn with the MODEL deciding when to call tools."""
    tools = tools_override if tools_override is not None else to_ollama_tools()
    loop_messages: list[dict[str, Any]] = [{"role": m.get("role"), "content": m.get("content", "")} for m in messages]
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    user_input = last_user.get("content", "") if last_user else ""

    saved_images: list[str] = []
    wants_image = detect_image_request(user_input)

    for round_no in range(MAX_TOOL_ROUNDS):
        if on_stage:
            on_stage(
                "image:generating"
                if (round_no == 0 and wants_image) or saved_images
                else ("chat:thinking" if round_no == 0 else "tool:executing")
            )
        log_info(f"[pipeline] Tool round {round_no + 1}/{MAX_TOOL_ROUNDS} — {model}")
        result = await stream_chat_with_tools(
            model, loop_messages, tools, on_chunk,
            StreamOptions(
                signal=signal,
                think=think,
                on_thinking=on_thinking,
                temperature=(extra_opts or {}).get("temperature"),
                top_p=(extra_opts or {}).get("top_p"),
                max_tokens=(extra_opts or {}).get("max_tokens"),
                base_url=_cloud_endpoint.get() or None,
                api_key=_cloud_api_key.get() or None,
            ),
        )
        content = result["content"]
        tool_calls = result["toolCalls"]

        # Real generation stats (tok/s) for the client UI — delivered on the
        # round that produced the final visible answer.
        if on_metrics and not tool_calls:
            try:
                on_metrics(result.get("metrics") or {})
            except Exception:  # noqa: BLE001
                pass

        if not tool_calls:
            return embed_generated_images(content, saved_images, on_chunk)

        loop_messages.append({"role": "assistant", "content": content, "tool_calls": tool_calls})
        for tc in tool_calls:
            name = tc.get("function", {}).get("name") or "unknown"
            args = tc.get("function", {}).get("arguments") or {}
            try:
                if name == "draw_image" and on_stage:
                    on_stage("image:generating")
                tool_result = await execute_tool(name, args, {"userInput": user_input})
            except Exception as e:  # noqa: BLE001
                tool_result = {"success": False, "output": f'Tool "{name}" crashed: {e}'}
            log_info(f'[pipeline] Tool "{name}" → {"ok" if tool_result.success else "error"}: {tool_result.output[:80]}')
            if name == "draw_image" and tool_result.success and tool_result.data and tool_result.data.get("filename"):
                filename = str(tool_result.data["filename"])
                if filename:
                    saved_images.append(filename)
            loop_messages.append({"role": "tool", "content": tool_result.output})

    # Cap reached — one final pass without tools
    log_info(f"[pipeline] Tool loop cap ({MAX_TOOL_ROUNDS}) reached — final plain pass")
    final = await stream_chat_with_tools(
        model, loop_messages, [], on_chunk,
        StreamOptions(
            signal=signal,
            think=think,
            on_thinking=on_thinking,
            temperature=(extra_opts or {}).get("temperature"),
            top_p=(extra_opts or {}).get("top_p"),
            max_tokens=(extra_opts or {}).get("max_tokens"),
            base_url=_cloud_endpoint.get() or None,
            api_key=_cloud_api_key.get() or None,
        ),
    )
    if on_metrics:
        try:
            on_metrics(final.get("metrics") or {})
        except Exception:  # noqa: BLE001
            pass
    return embed_generated_images(final["content"], saved_images, on_chunk)


# ─── Image request detection ────────────────────────────────
IMAGE_VERBS = "generate|draw|make|create|produce|paint|render|design|build|sketch|illustrate|imagine"
IMAGE_NOUNS = "image|picture|photo|photograph|artwork|art|logo|icon|illustration|portrait|avatar|sketch|drawing|meme|wallpaper|banner|poster|mascot|character|cartoon"


def detect_image_request(text: str) -> bool:
    if not text:
        return False
    lower = re.sub(r"\s+", " ", text.lower()).strip()
    if re.search(
        r"\b(explain|describe|what is|what are|how (does|do|to|can i)|tell me about|why is|meaning of|difference between|tutorial)\b",
        lower,
    ):
        return False
    if re.search(rf"\b({IMAGE_VERBS})\b[^.!?\n]{{0,100}}\b({IMAGE_NOUNS})\b", lower, re.IGNORECASE):
        return True
    return bool(
        re.search(
            rf"\b(image|picture|photo|photograph|portrait|avatar)\b[^.!?\n]{{0,60}}\bof (an?|the|my|our|a few|some)\b",
            lower,
            re.IGNORECASE,
        )
    )


def extract_svg(text: str) -> str:
    start = text.find("<svg")
    end = text.rfind("</svg>")
    if start == -1 or end == -1:
        return ""
    return text[start : end + len("</svg>")]


async def ensure_image_drawn(base_text: str, o: dict[str, Any]) -> str:
    """Fallback when the model never called draw_image: one dedicated no-tools
    call that returns ONLY an SVG, then save + append the markdown image."""
    if o.get("on_stage"):
        o["on_stage"]("image:generating")
    system = (
        "You are a vector-art generator. Produce ONE complete standalone SVG document that draws the requested picture.\n"
        "Rules:\n"
        "- Output ONLY the raw SVG, starting with <svg and ending with </svg>. No markdown fences, no commentary, no extra words.\n"
        '- Declare xmlns, width="1024", height="1024", viewBox="0 0 1024 1024".\n'
        "- Flat vector style: rect, circle, ellipse, polygon, path and gradients inside <defs>; draw background first, foreground last.\n"
        "- NEVER use <text> (no fonts available). Keep it under ~60 elements — a clean simple scene beats a busy one."
    )

    chunks: list[str] = []

    def chunk_cb(chunk: str) -> None:
        chunks.append(chunk)

    try:
        result = await stream_chat_with_tools(
            o["model"],
            [
                {"role": "system", "content": system},
                {"role": "user", "content": o["request"]},
            ],
            [],
            chunk_cb,
            StreamOptions(
                signal=o.get("signal"),
                think=False,
                temperature=o.get("temperature"),
                top_p=o.get("top_p"),
                max_tokens=o.get("max_tokens"),
                base_url=_cloud_endpoint.get() or None,
                api_key=_cloud_api_key.get() or None,
            ),
        )
        content = result["content"] or "".join(chunks)
    except Exception as e:  # noqa: BLE001
        log_warn("[pipeline] Image fallback call failed:", e)
        return base_text

    svg = extract_svg(content)
    check = sanitize_svg(svg)
    if not check["ok"]:
        log_warn(f"[pipeline] Image fallback produced unusable SVG: {check['error']}")
        return base_text

    try:
        art = await save_artwork(svg)
        markdown = f"![Generated image](/api/generated/{art['filename']})"
        log_info(f"[pipeline] Image fallback saved {art['filename']}")
        appended = ("\n\n" if base_text.strip() else "") + markdown
        o["on_chunk"](appended)
        return base_text.strip() + appended if base_text.strip() else markdown
    except Exception as e:  # noqa: BLE001
        log_error("[pipeline] Image fallback save failed:", e)
        return base_text


async def run_draw_image_chat(o: dict[str, Any]) -> str:
    """Shared 'the user asked for a picture' path for BOTH plain chat and
    agent (Koding) mode — tool nudge + guaranteed SVG fallback."""
    nudge = (
        "\n\nThe user asked for an image. Call the draw_image tool, passing your complete SVG "
        "(read its description for the scene rules), then include the exact markdown image it returns in your reply."
    )
    system_messages = [
        {**m, "content": (m.get("content", "") + nudge)} if idx == 0 else m
        for idx, m in enumerate(o["systemMessages"])
    ]
    chat_messages: list[Message] = [*system_messages, *o["messages"]]

    reply = await run_chat_tool_loop(
        "chat",
        o["model"],
        chat_messages,
        o["think"],
        o["on_chunk"],
        o.get("signal"),
        {"temperature": o.get("temperature"), "top_p": o.get("top_p"), "max_tokens": o.get("max_tokens")},
        o.get("on_thinking"),
        o.get("on_stage"),
        to_chat_tools(),
    )

    if "/api/generated/" in reply:
        return reply
    log_info("[pipeline] Model replied without draw_image — running SVG fallback")
    return await ensure_image_drawn(
        reply,
        {
            "model": o["model"],
            "request": o["requestText"],
            "signal": o.get("signal"),
            "on_chunk": o["on_chunk"],
            "on_stage": o.get("on_stage"),
            "temperature": o.get("temperature"),
            "top_p": o.get("top_p"),
            "max_tokens": o.get("max_tokens"),
        },
    )


async def build_memory_context(user_id: str | None = None) -> str | None:
    if not user_id:
        return None
    try:
        memory = await get_memory(user_id)
        if not memory.get("enabled") or not memory.get("categories"):
            return None
        lines = ["Here is what I know about you:"]
        for category, entries in memory.get("categories", {}).items():
            lines.append(f"\n# {category}")
            for key, value in entries.items():
                lines.append(f"- {key}: {value}")
        lines.append("\nUse this information naturally in our conversation. If I share updated info, update your knowledge.")
        return "\n".join(lines)
    except Exception:  # noqa: BLE001
        return None


# ─── Main pipeline ───────────────────────────────────────────
async def run_pipeline(opts: dict[str, Any]) -> str:
    from .agent import run_agent_loop

    model = opts["model"]
    # The model the user actually picked in the client. The server-side
    # "Chat" assignment must NOT override it — it's a fallback for when the
    # client doesn't send a model (and for cloud routing), not a veto.
    # (Port bug: unconditionally overwriting it forced every chat onto
    # modelAssignments.chat — e.g. a leftover qwen3:0.6b — producing
    # 31-char junk replies no matter what the user selected.)
    requested_model = model
    mode = opts.get("mode")
    workspace_path = opts.get("workspacePath")
    signal = opts.get("signal")
    on_stage = opts.get("onStage")
    on_chunk = opts.get("onChunk")
    user_id = opts.get("userId")
    user_name = opts.get("userName")
    planning_enabled = opts.get("planningEnabled")
    temperature = opts.get("temperature")
    top_p = opts.get("top_p")
    max_tokens = opts.get("max_tokens")
    on_thinking = opts.get("onThinking")
    # Receives {eval_count, eval_duration_ns} when the reply finishes so the
    # client can show real tokens/s (emitted as a "metrics" SSE event).
    on_metrics = opts.get("onMetrics")
    messages: list[Message] = list(opts["messages"])

    # Every search this run makes reports the pages it used here (see
    # search.set_source_sink) — the client shows them under the answer. Set
    # before any search can start so child tasks inherit it.
    set_source_sink(opts.get("onSources"))

    intent = await detect_intent(messages, mode)

    # ─── Dangerous-content guard ──────────────────────────
    dangerous = find_dangerous_request(messages)
    if dangerous:
        log_info(f"[pipeline] Blocked dangerous request ({dangerous})")
        on_chunk(DANGEROUS_REPLY)
        return DANGEROUS_REPLY

    # ─── Cloud mode routing ───────────────────────────────
    _cloud_endpoint.set("")
    _cloud_api_key.set("")
    cloud_cleared = False
    try:
        cloud_settings = await get_cloud_settings()
        cloud_mode = cloud_settings["cloudMode"]
        cloud_api_key = cloud_settings["cloudApiKey"]
        cloud_endpoint = cloud_settings["cloudEndpoint"]
        log_info(f"[pipeline] Cloud mode: {cloud_mode}, hasApiKey: {bool(cloud_api_key)}")

        if cloud_mode == "cloud" and not cloud_api_key:
            # Cloud-only means ONLY cloud — no silent local fallback.
            log_info("[cloud] Cloud-only mode with no API key configured")
            if on_stage:
                on_stage("cloud:unavailable")
            raise OllamaError(
                "Cloud mode is enabled but no API key is configured — "
                "add one in Settings → Cloud, or switch cloud mode to Auto to use local models."
            )
        elif cloud_mode != "local" and cloud_api_key and cloud_endpoint:
            _cloud_endpoint.set(cloud_endpoint)
            _cloud_api_key.set(cloud_api_key)
            log_info(f"[pipeline] Cloud routing enabled: {cloud_endpoint}")
            try:
                # Probe with the SAME auth path as a real chat call — see
                # app/cloud_auth.py for why the POST /api/chat probe is the only
                # trustworthy signal (GET endpoints lie). The Server app's
                # "Test Connection" button shares this helper, so the two can
                # never disagree about whether a key works.
                probe = await verify_cloud_key(cloud_endpoint, cloud_api_key)
                if not probe["ok"]:
                    raise RuntimeError(probe["message"])
            except Exception as probe_err:  # noqa: BLE001
                log_warn(f"[pipeline] Cloud unreachable ({probe_err})")
                if cloud_mode == "cloud":
                    # Cloud-only mode: the user asked for cloud. Failing back to
                    # local here would silently run the wrong model — surface
                    # an actionable error instead so they can fix the key.
                    if on_stage:
                        on_stage("cloud:unavailable")
                    raise OllamaError(
                        "Cloud mode is enabled but the cloud API key is invalid, expired or revoked — "
                        "check Settings → Cloud, or switch cloud mode to Auto to fall back to local models."
                    )
                # Auto mode: clear routing and continue on local models.
                if on_stage:
                    on_stage("cloud:unavailable")
                _cloud_endpoint.set("")
                _cloud_api_key.set("")
                cloud_cleared = True

        resolved_chat = await get_resolved_model("chat")
        if resolved_chat["source"] == "cloud":
            log_info(f"[pipeline] Chat model resolved to cloud: {resolved_chat['model']}")
            model = resolved_chat["model"]
        else:
            # Honor the model picked in the client; the assignment is only
            # used when the request didn't carry one.
            model = requested_model or resolved_chat["model"]
            log_info(
                f"[pipeline] Chat model resolved to local: {model}"
                + ("" if model == requested_model else " (assignment fallback)" if model == resolved_chat["model"] else "")
            )
        if resolved_chat["source"] == "cloud" and _cloud_endpoint.get():
            try:
                input_text = "\n".join(m.get("content", "") for m in messages)
                await _track_cloud_usage(resolved_chat["model"], _estimate_tokens(input_text))
            except Exception:  # noqa: BLE001
                pass
    except OllamaError:
        # Strict cloud-only failures must reach the client as an error event,
        # not be swallowed into a silent local fallback.
        raise
    except Exception as e:  # noqa: BLE001
        log_error("[pipeline] Failed to resolve chat model:", e)

    # ─── Adaptive thinking ─────────────────────────────────
    thinking_mode = opts.get("thinkingMode") or ("off" if opts.get("thinkingEnabled") is False else "auto")
    last_user_for_think = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    is_agent_mode = mode == "agent"
    think = False if thinking_mode == "off" else (True if is_agent_mode else needs_thinking(last_user_for_think.get("content", "") if last_user_for_think else ""))
    log_info(f"[pipeline] Thinking mode: {thinking_mode}, agent: {is_agent_mode} → think: {think}")

    if think and not (await _supports_thinking(model)):
        resolved = await get_resolved_model("chat_thinking")
        if resolved["model"] and resolved["model"] != model:
            log_info(f"[pipeline] Auto-thinking: {model} can't think → using {resolved['model']} (source: {resolved['source']})")
            # Say so in the reply: the swap used to be silent, so testing a
            # non-thinking model looked like it "answered" when another model
            # did, and the thinking the user saw came from that other model.
            on_chunk(f"_⚙️ {model} can't think — answering this one with {resolved['model']}._\n\n")
            model = resolved["model"]

    # Cloud routing was probed and failed — the model name may still be a
    # cloud-only one (resolved local because no cloud assignment existed).
    # Swap it for a locally installed model so the call actually succeeds.
    if cloud_cleared and not _cloud_endpoint.get():
        try:
            installed = {m.get("name") or "" for m in await get_models()}
            installed.discard("")
        except Exception:  # noqa: BLE001
            installed = set()
        local_model = await get_model_assignment("chat")
        replacement = ""
        if model not in installed:
            if local_model and local_model in installed:
                replacement = local_model
            elif installed:
                replacement = sorted(installed)[0]
        if replacement:
            log_info(f"[pipeline] Cloud cleared, swapping unavailable model {model} → local {replacement}")
            model = replacement
        elif model and (await get_resolved_model("chat"))["source"] == "cloud":
            model = requested_model or local_model
            log_info(f"[pipeline] Cloud cleared, forcing local: {model}")

    # Report final model to frontend. The source MUST reflect the routing
    # that will actually happen (cloud endpoint set or not) — the assignment
    # lookup alone reported "cloud" for fallback-local models after a probe
    # failure, mislabeling the reply in the client.
    try:
        actual_source = "cloud" if _cloud_endpoint.get() else "local"
        if opts.get("onModelInfo"):
            opts["onModelInfo"](model, actual_source)
    except Exception:  # noqa: BLE001
        pass

    # ─── IMAGE REQUESTS IN AGENT (KODING) MODE ────────────
    if mode == "agent" and not intent["hasImage"]:
        agent_user_text = re.sub(r"\[image:[^\]]+\]", "", last_user_for_think.get("content", "") if last_user_for_think else "").strip()
        if agent_user_text and detect_image_request(agent_user_text):
            log_info("[pipeline] Image request in agent mode — using draw pipeline instead of agent loop")
            code_model = (await get_resolved_model("code"))["model"]
            draw_model = code_model or model
            draw_system = await with_ai_rules(
                "You are a friendly assistant generating an image for the user.\n"
                "Warm and brief. If your draw_image tool call succeeded, include the markdown image it returned in your reply — it is important the user sees it.",
                "chat",
            )
            return await run_draw_image_chat(
                {
                    "model": draw_model,
                    "systemMessages": [{"role": "system", "content": draw_system}],
                    "messages": messages,
                    "requestText": agent_user_text,
                    "think": False,
                    "signal": signal,
                    "temperature": temperature,
                    "top_p": top_p,
                    "max_tokens": max_tokens,
                    "on_chunk": on_chunk,
                    "on_thinking": on_thinking,
                    "on_stage": on_stage,
                }
            )

    # ─── AGENT LOOP (auto-apply mode) ─────────────────────
    if mode == "agent" and opts.get("autoApply") is True and not intent["hasImage"]:
        log_info("[pipeline] Koding mode with auto-apply — running autonomous loop")
        memory_context = await build_memory_context(user_id)
        agent_model = (await get_resolved_model("code"))["model"]
        # Hard-fail guard: the code assignment may name a model that isn't
        # installed (fresh install, deleted model) — the whole Koding turn
        # then died with a 404 before doing anything. Fall back to the model
        # the user actually picked.
        if agent_model and agent_model != model:
            try:
                installed = {m.get("name") or "" for m in await get_models()}
                base = agent_model.split(":")[0]
                if agent_model not in installed and not any(n.split(":")[0] == base for n in installed):
                    log_warn(f"[pipeline] Code model {agent_model} not installed — using {model} instead")
                    agent_model = model
            except Exception:  # noqa: BLE001
                pass
        if agent_model and agent_model != model:
            log_info(f"[pipeline] Agent mode: using code model {agent_model} instead of chat model {model}")
        return await run_agent_loop(
            {
                "model": agent_model or model,
                "messages": messages,
                "workspacePath": workspace_path,
                "autoApply": True,
                "userName": user_name,
                "signal": signal,
                "think": think,
                "askKey": opts.get("conversationId"),
                "resumeState": opts.get("resumeState"),
                "toolPermission": opts.get("toolPermission"),
                "cloudEndpoint": _cloud_endpoint.get() or None,
                "cloudApiKey": _cloud_api_key.get() or None,
                "planMode": opts.get("planMode"),
                "callbacks": {
                    "onStage": on_stage,
                    "onChunk": on_chunk,
                    "onMetrics": on_metrics,
                    "onToolStart": opts.get("onAgentTool"),
                    "onToolResult": opts.get("onToolResult"),
                    "onFileWritten": opts.get("onFileWritten"),
                    "onThinking": on_thinking,
                    "onNarration": opts.get("onNarration"),
                    "onAgentCommand": opts.get("onAgentCommand"),
                    "onQuestion": opts.get("onQuestion"),
                    "onResumeState": opts.get("onResumeState"),
                    "onApprovalRequest": opts.get("onApprovalRequest"),
                    "onPlan": opts.get("onPlan"),
                },
                "temperature": temperature,
                "top_p": top_p,
                "max_tokens": max_tokens,
                "extraContext": memory_context or None,
            }
        )

    log_info(
        f"[pipeline] Intent: hasImage={intent['hasImage']}, wantsCode={intent['wantsCode']}, "
        f"wantsFileInfo={intent['wantsFileInfo']}, wantsTool={intent['wantsTool']}, think={think}"
    )

    # ─── Message Truncation ───────────────────────────────
    MAX_HISTORY = 30
    if len(messages) > MAX_HISTORY:
        original_len = len(messages)
        system_msgs = [m for m in messages if m.get("role") == "system"]
        recent_msgs = messages[-MAX_HISTORY:]
        messages = [*system_msgs, *recent_msgs]
        log_info(f"[pipeline] Truncated messages from {original_len} to {len(messages)} (max {MAX_HISTORY})")

    # ─── Context Gathering (parallelized) ─────────────────
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    user_text = re.sub(r"\[image:[^\]]+\]", "", last_user.get("content", "") if last_user else "").strip()

    needs_file_listing = intent["wantsFileInfo"] or (intent["wantsCode"] and planning_enabled)
    # The message alone decides WHETHER to search; what gets searched is a
    # subject that may come from an earlier turn (see resolve_search_query).
    search_query = None if intent["hasImage"] else resolve_search_query(user_text, messages)
    should_search = search_query is not None
    if should_search and search_query != user_text:
        log_info(f'[pipeline] Search subject resolved to: "{search_query}"')

    if needs_file_listing and workspace_path and on_stage:
        on_stage("reading:workspace")
    if should_search and on_stage:
        on_stage("search:web")

    async def _file_listing_task() -> str:
        result = await list_workspace_files(workspace_path)
        log_info(f"[pipeline] Workspace file listing: {result[:200]}...")
        return result

    file_listing, memory_context, web_context = await asyncio.gather(
        _file_listing_task() if (needs_file_listing and workspace_path) else _noop_str(),
        build_memory_context(user_id),
        get_web_context(search_query) if should_search else _noop_none(),
    )

    if user_text and not should_search and not intent["hasImage"]:
        if needs_web_search(user_text):
            # It wanted to search but had nothing to search for ("search it up"
            # as the first message). Better to answer than to search the words.
            log_info(
                f'[pipeline] Skipped web search — "{user_text[:60]}" carries no subject '
                "of its own and no earlier turn to borrow one from"
            )
        else:
            log_info(f'[pipeline] Skipped web search (heuristic) for: "{user_text[:60]}..."')

    def with_context(content: str) -> str:
        result = content
        if memory_context:
            result += "\n\n---\n\n" + memory_context
        if web_context:
            result += (
                "\n\n---\n\n"
                "[WEB SEARCH RESULTS — CURRENT AND LIVE]\n\n"
                "The information below was retrieved from the internet in real-time through a web search. It is MORE CURRENT than my training data.\n\n"
                "INSTRUCTIONS TO ANSWER:\n"
                "- I MUST answer the user's question using THESE search results as my primary source of truth\n"
                "- I should answer DIRECTLY with the facts from these results — do NOT just provide links or tell the user to visit websites\n"
                "- If the results contain the answer, state it clearly and confidently in my response\n"
                "- Treat this information as accurate and current\n"
                "- Only mention website URLs if the user specifically asks for sources\n"
                "- If the results don't contain enough info to answer, say so honestly\n\n"
                f"Search results:\n{web_context}"
            )
        return result

    # Tool output variables — shared by TOOL STAGE and simple chat
    tool_output: str | None = None
    tool_stage_handled = False
    tool_succeeded = False

    # TOOL STAGE (heuristic fallback) — chat mode only
    if mode != "agent" and intent["wantsTool"] and intent.get("toolId"):
        if on_stage:
            on_stage("tool:executing")
        last_msg = messages[-1]
        user_input = last_msg.get("content", "")
        try:
            result = await execute_tool(intent["toolId"], intent.get("toolParams") or {}, {"userInput": user_input})
            tool_output = result.output
            tool_stage_handled = True
            tool_succeeded = result.success
            log_info(f"[pipeline] Tool \"{intent['toolId']}\" result: {result.output[:100]}")
        except Exception as e:  # noqa: BLE001
            log_error(f'[pipeline] Tool "{intent["toolId"]}" failed:', e)
            tool_output = f'Sorry, the {intent["toolId"]} tool encountered an error.'
            tool_stage_handled = True
            tool_succeeded = False

    # Simple chat — no pipeline needed
    if not intent["hasImage"] and not intent["wantsCode"]:
        if tool_stage_handled and tool_succeeded and tool_output:
            on_chunk(tool_output)
            return tool_output

        if on_stage:
            on_stage("chat:thinking")

        if mode == "agent":
            file_info = (
                "Here are the ACTUAL files in this workspace (read from disk):\n" + file_listing
                + "\n\nUse this listing to answer questions about files. Do NOT make up files that are not listed here."
                if file_listing
                else "You cannot read files or list directories directly. If asked about files, say you cannot see them and offer to generate code instead."
            )
            agent_system = with_context(
                await with_ai_rules(
                    "You are an AI coding agent helping " + (user_name or "a user") + " build projects in their workspace.\n"
                    "Your workspace is at: " + (workspace_path or "(not set)") + "\n\n"
                    + file_info
                    + "\n\nIf asked a question, answer conversationally.\n"
                    "All file operations are limited to your workspace. Do NOT reference files outside it.",
                    "agent",
                )
            )
            agent_messages: list[Message] = [{"role": "system", "content": agent_system}, *messages]
            return await run_visible_stage(
                "chat", model, agent_messages, think, on_chunk, signal,
                {"temperature": temperature, "top_p": top_p, "max_tokens": max_tokens},
                on_thinking, on_metrics,
            )

        # Plain chat
        context_parts: list[str] = []
        if memory_context:
            context_parts.append(memory_context)
        if web_context:
            context_parts.append(
                "[WEB SEARCH RESULTS — CURRENT AND LIVE]\n\n"
                "The information below was retrieved from the internet in real-time through a web search. It is MORE CURRENT than my training data.\n\n"
                "INSTRUCTIONS TO ANSWER:\n"
                "- I MUST answer the user's question using THESE search results as my primary source of truth\n"
                "- I should answer DIRECTLY with the facts from these results — do NOT just provide links or tell the user to visit websites\n"
                "- If the results contain the answer, state it clearly and confidently in my response\n"
                "- I should treat this information as accurate and current\n"
                "- Only mention website URLs if the user specifically asks for sources\n"
                "- If the results don't contain enough info to answer, I should say so honestly\n\n"
                f"Search results:\n{web_context}"
            )
        combined_context = "\n\n---\n\n".join(context_parts) if context_parts else None

        chat_system = await with_ai_rules(
            "You are a real person — a friend the user is chatting with, not a chatbot.\n"
            "Be conversational: contractions, short answers, match their tone.\n"
            "Lead with the answer. Never open with \"I can provide...\", \"Based on...\", \"As an AI...\", \"Great question!\".\n"
            "Answer their ACTUAL question — never go off-topic.\n"
            "Never fabricate facts, numbers, dates, or sources. Say \"I don't know\" if unsure.\n"
            "Never apologize — just fix it and move on.\n"
            "Keep answers concise unless asked for detail.\n"
            "Refuse dangerous requests in one short sentence, then offer alternatives.",
            "chat",
        )
        chat_system_messages: list[Message] = [
            {
                "role": "system",
                "content": chat_system
                + (
                    f"\n\n[A tool was attempted but failed: {tool_output}. Answer the user's question normally — don't dwell on the tool unless it genuinely helps.]"
                    if tool_stage_handled and not tool_succeeded
                    else ""
                ),
            },
        ]
        if combined_context:
            chat_system_messages.append({"role": "system", "content": combined_context})
        chat_messages: list[Message] = [*chat_system_messages, *messages]

        if detect_image_request(user_text):
            return await run_draw_image_chat(
                {
                    "model": model,
                    "systemMessages": chat_system_messages,
                    "messages": messages,
                    "requestText": user_text,
                    "think": think,
                    "signal": signal,
                    "temperature": temperature,
                    "top_p": top_p,
                    "max_tokens": max_tokens,
                    "on_chunk": on_chunk,
                    "on_thinking": on_thinking,
                    "on_stage": on_stage,
                }
            )

        return await run_chat_tool_loop(
            "chat", model, chat_messages, think, on_chunk, signal,
            {"temperature": temperature, "top_p": top_p, "max_tokens": max_tokens},
            on_thinking, None, to_chat_tools(),
            on_metrics=on_metrics,
        )

    image_description = ""
    plan_output = ""
    code_output = ""

    # STAGE 1: Vision analysis (internal)
    if intent["hasImage"] and intent.get("imageDataUrl"):
        if on_stage:
            on_stage("vision:analyzing")
        vision_messages: list[Message] = [
            {
                "role": "system",
                "content": (
                    "You are a vision description assistant. Your ONLY job is to describe what you see in the image in plain text.\n\n"
                    "Rules:\n"
                    "- Describe layout, colors, typography, components, structure, text content, design style\n"
                    "- Be specific and technical (positions, visual hierarchy)\n"
                    "- Plain text only, 2-4 paragraphs\n"
                    "- NO code, NO HTML, NO CSS, NO JavaScript, NO examples, NO implementations\n"
                    "- NO markdown code blocks\n"
                    "- The description will be used by other AIs to write code, so be thorough but factual"
                ),
            },
            {"role": "user", "content": f"Describe this image in detail: [image:{intent['imageDataUrl']}]"},
        ]
        try:
            vision = await get_resolved_model("vision")
            vision_model, vision_source = vision["model"], vision["source"]
            log_info(f"[pipeline] Vision model: {vision_model} (source: {vision_source})")
            image_description = await run_internal_stage(
                "vision", vision_model, vision_messages, False, signal,
                {"temperature": temperature, "top_p": top_p, "max_tokens": max_tokens},
                None, on_stage,
            )
            if vision_source == "cloud":
                await _track_cloud_usage(
                    vision_model,
                    _estimate_tokens("\n".join(m.get("content", "") for m in vision_messages)),
                    _estimate_tokens(image_description),
                )
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log_error("[pipeline] Vision stage failed:", e)

    # STAGE 2: Planning (visible)
    if intent["wantsCode"] and planning_enabled:
        if on_stage:
            on_stage("planning:create")
        user_text = re.sub(
            r"\[image:data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+\]", "",
            messages[-1].get("content", ""),
        ).strip()
        vision_context = f"\nThe user also provided an image with this description: {image_description}" if image_description else ""
        plan_messages: list[Message] = [
            {
                "role": "system",
                "content": (
                    f"You are a technical planning agent helping {user_name or 'a user'} with their coding project.\n"
                    f"Your workspace is at: {workspace_path or '(not set)'}\n\n"
                    + (f"Current workspace files:\n{file_listing}\n" if file_listing else "")
                    + "\nYour job is to create a CLEAR, CONCISE plan BEFORE any code is written.\n\n"
                    "The plan should include:\n"
                    "- A summary of what needs to be done\n"
                    "- The list of files that will be created, modified, or deleted\n"
                    "- The key technical decisions or approach\n"
                    "- Any dependencies or important considerations\n\n"
                    "Keep it brief — 3-6 bullet points. Do NOT write any code yet. Just plan.\n\n"
                    f"User request: {user_text}{vision_context}\n\n"
                    "Output ONLY the plan — no introductory text, no conclusion, no code blocks."
                ),
            }
        ]
        try:
            planning = await get_resolved_model("code")
            planning_model, planning_source = planning["model"], planning["source"]
            log_info(f"[pipeline] Planning model: {planning_model} (source: {planning_source})")
            plan_output = await run_visible_stage(
                "planning", planning_model, plan_messages, False, on_chunk, signal,
                {"temperature": temperature, "top_p": top_p, "max_tokens": max_tokens},
            )
            log_info(f"[pipeline] Planning done. Length: {len(plan_output)}")
            if planning_source == "cloud":
                await _track_cloud_usage(
                    planning_model,
                    _estimate_tokens("\n".join(m.get("content", "") for m in plan_messages)),
                    _estimate_tokens(plan_output),
                )
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log_error("[pipeline] Planning stage failed:", e)

    # STAGE 3: Code generation (internal)
    if intent["wantsCode"]:
        from .agent import collect_referenced_files

        if not file_listing and on_stage:
            on_stage("reading:workspace")
        user_text = re.sub(
            r"\[image:data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+\]", "",
            messages[-1].get("content", ""),
        ).strip()

        ref_context = ""
        if mode == "agent" and user_text:
            ref_contents = await collect_referenced_files(user_text, workspace_path)
            if ref_contents:
                ref_context = ref_contents

        code_context = (
            f"Based on this image analysis:\n\n{image_description}\n\nUser request: {user_text}\n\nGenerate the code."
            if image_description
            else user_text
        )
        plan_instructions = (
            "\n\n---\n\nA plan has already been created and shared with the user above. Follow this plan EXACTLY when generating code:\n"
            + plan_output
            + "\n\nGenerate code that implements this plan precisely. Do NOT deviate from the plan unless the user explicitly asks for changes."
            if plan_output
            else ""
        )

        if mode == "agent":
            code_system_prompt = (
                f"You are an expert developer working in a code agent workspace for {user_name or 'a user'}.\n"
                f"Your workspace directory is: {workspace_path or '(not set)'}\n\n"
                + (f"Here are the ACTUAL files already in the workspace:\n{file_listing}\n\nDo NOT recreate files that already exist unless the user asks. Update them instead.\n" if file_listing else "")
                + "All file paths you generate MUST be relative to this directory.\n\n"
                "Generate clean, working code in markdown code blocks."
                + (f"\n\n{ref_context}" if ref_context else "")
                + "\n\nIMPORTANT: Start EVERY code block with a comment on the FIRST LINE showing the relative file path, like:\n"
                "// index.html\n// src/style.css\n// src/app.js\n// lib/helper.ts\n// backend/routes/api.ts\n\n"
                "Use the appropriate comment syntax for each language:\n"
                "- // for JS/TS/CSS/Go/Rust\n- # for Python/YAML/Ruby\n- <!-- --> for HTML/XML\n- ; for INI\n- -- for SQL\n\n"
                "EDIT vs NEW FILES:\n"
                '- For a NEW file: output a code block with the path comment on the first line (e.g. "// src/app.ts") and the ENTIRE new file content.\n'
                '- For an EXISTING file that you only partially change: use an EDIT block instead — first line "// EDIT: path/to/file.ext" (with the appropriate comment prefix for the language), then the exact old lines under "OLD:", then a line with only ---, then the replacement lines under "NEW:". Example:\n\n'
                "// EDIT: src/app.ts\nOLD:\nconst x = 1;\nconst y = 2;\n---\nNEW:\nconst x = 10;\nconst y = 20;\n\n"
                "- The OLD: section must match the CURRENT file content exactly (read it from the provided file contents). Only include the lines you are changing. This keeps edits surgical and fast — do NOT rewrite entire existing files when only part changes.\n"
                "- For a COMPLETE rewrite of an existing file (most of the file changes), a full code block is acceptable.\n\n"
                '- For DELETING a file: output a code block with "// DELETE: path/to/file.ext" as the only line.\n\n'
                "CRITICAL: Output ONLY code blocks. No explanations before or after."
                + plan_instructions
            )
        else:
            code_system_prompt = (
                "You are an expert developer. Generate clean, working code based on the user's request.\n"
                + (f"\n\n{ref_context}\n\n" if ref_context else "\n\n")
                + f"{code_context}\n\n"
                "Output code in markdown code blocks.\n"
                "Start EVERY code block with a comment showing the file path:\n"
                "// filename.ext\n\n"
                + plan_instructions
                + "\n\nOutput ONLY code blocks. No explanations before or after."
            )

        code_system = with_context(await with_ai_rules(code_system_prompt, "agent" if mode == "agent" else "chat"))
        code_messages: list[Message] = [{"role": "system", "content": code_system}, *messages]
        try:
            code = await get_resolved_model("code")
            code_model, code_source = code["model"], code["source"]
            log_info(f"[pipeline] Code model: {code_model} (source: {code_source})")
            code_output = await run_internal_stage(
                "code", code_model, code_messages, think, signal,
                {"temperature": temperature, "top_p": top_p, "max_tokens": max_tokens},
                on_thinking, on_stage,
            )
            log_info(f"[pipeline] Code done. Length: {len(code_output)}")
            if code_source == "cloud":
                await _track_cloud_usage(
                    code_model,
                    _estimate_tokens("\n".join(m.get("content", "") for m in code_messages)),
                    _estimate_tokens(code_output),
                )
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log_error("[pipeline] Code generation failed:", e)
            code_output = f"I encountered an error generating code. Please try again.\n\nError: {e}"

    # ─── Final response ─────────────────────────────────────
    if on_stage:
        on_stage("chat:thinking")

    pipeline_context: list[str] = []
    if image_description:
        pipeline_context.append(f"The user's image shows: {image_description}")
    if plan_output:
        pipeline_context.append(f"Plan created:\n{plan_output}")
    if code_output:
        pipeline_context.append(f"Generated code:\n{code_output}")

    summary_prompt = (
        "The pipeline has completed. Here is a summary of the results:\n\n"
        + "\n\n---\n\n".join(pipeline_context)
        + "\n\nNow provide a brief, friendly summary to the user. If there's code, present the key files. If there's a plan, present it. Be conversational — not robotic."
        if pipeline_context
        else "The pipeline has completed but produced no output. Tell the user something went wrong and ask them to try again."
    )

    summary_messages: list[Message] = [
        {
            "role": "system",
            "content": await with_ai_rules(
                "You are a helpful assistant summarizing pipeline output for the user.\nBe concise and conversational. Present results clearly.",
                "chat",
            ),
        },
        *messages,
        {"role": "user", "content": summary_prompt},
    ]

    return await run_visible_stage(
        "chat", model, summary_messages, False, on_chunk, signal,
        {"temperature": temperature, "top_p": top_p, "max_tokens": max_tokens},
        on_thinking, on_metrics,
    )


async def _noop_str() -> str:
    return ""


async def _noop_none() -> None:
    return None


from .capabilities import supports_thinking as _supports_thinking  # noqa: E402