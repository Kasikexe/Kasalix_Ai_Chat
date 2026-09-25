"""Model assignments — mirrors backend/src/services/model-assignments.ts.

Assignable model roles; priority: settings file > env var > default.
"""

from __future__ import annotations

import os

from .settings_store import read_settings_cached

ASSIGNMENT_KEYS = ["chat", "chat_thinking", "code", "vision", "extraction", "search"]

ASSIGNMENT_LABELS = {
    "chat": "Chat",
    "chat_thinking": "Chat (Thinking)",
    "code": "Code Generation",
    "vision": "Vision Analysis",
    "extraction": "Memory Extraction",
    "search": "Web Search",
}

ASSIGNMENT_ICONS = {
    "chat": "\U0001f4ac",
    "chat_thinking": "\U0001f9e0",
    "code": "\U0001f4bb",
    "vision": "\U0001f441\ufe0f",
    "extraction": "\U0001f9e0",
    "search": "\U0001f310",
}

DEFAULTS = {
    "chat": "qwen3:4b",
    "chat_thinking": "qwen3:4b",
    "code": "qwen2.5-coder:7b",
    "vision": "qwen2.5vl:3b",
    "extraction": "qwen2.5:3b",
    "search": "qwen2.5:3b",
}

# Human-readable explanation of where each category's model is actually used
# (get_resolved_model call sites). Served via GET /api/models/usage-map so the
# server GUI can show "Where it's used" under each assignment card. Keep in
# sync with pipeline.py / routes/chat.py / search.py / extractor.py / agent.py.
MODEL_USAGE_DESCRIPTIONS: dict[str, list[str]] = {
    "chat": [
        "Regular chatting — Chat mode, and Koding narration/final answers",
        "Thinking ON — used directly when this model supports thinking",
        "Conversation titles (auto-generated from the first message)",
    ],
    "chat_thinking": [
        "Thinking ON — only when the Chat model itself can't think",
        "Unused when Chat supports thinking (the toggle flips a flag on it)",
    ],
    "code": [
        "Koding (agent) mode — the autonomous multi-tool loop",
        "Code generation and the visible Plan step in Koding",
        "Koding planning phase (when Plan mode is ON)",
        "Drawing images (draw_image) requested inside Koding",
    ],
    "vision": [
        "Describing images attached to chat messages (read_image)",
        "Describing Koding preview screenshots — only when the Code model can't see images itself",
    ],
    "extraction": [
        "Memory extraction — what the app remembers after each answer",
    ],
    "search": [
        "Summarizing web-search results into the answer context",
    ],
}

# Env-var names for legacy backward compatibility
ENV_MAP = {
    "chat": "CHAT_MODEL",
    "chat_thinking": "CHAT_THINKING_MODEL",
    "code": "CODE_MODEL",
    "vision": "VISION_MODEL",
    "extraction": "EXTRACTOR_MODEL",
    "search": "SEARCH_MODEL",
}


async def get_model_assignment(category: str) -> str:
    """Get the assigned model for a category (settings > env > default)."""
    settings = read_settings_cached()
    ma = settings.get("modelAssignments")
    # An EXPLICIT value wins — even an empty string ("none" for that category).
    if isinstance(ma, dict) and isinstance(ma.get(category), str):
        return ma[category]
    # Backward compat: older settings stored separate thinking/fast chat models
    if category == "chat":
        if isinstance(ma, dict) and ma.get("chat_thinking"):
            return ma["chat_thinking"]
        if isinstance(ma, dict) and ma.get("chat_fast"):
            return ma["chat_fast"]

    env_var = ENV_MAP.get(category)
    if env_var and os.environ.get(env_var):
        return os.environ[env_var]
    if category == "chat":
        if os.environ.get("CHAT_THINKING_MODEL"):
            return os.environ["CHAT_THINKING_MODEL"]
        if os.environ.get("CHAT_FAST_MODEL"):
            return os.environ["CHAT_FAST_MODEL"]

    return DEFAULTS.get(category, "")


async def get_resolved_model(category: str) -> dict[str, str]:
    """Resolved model for a category with cloud mode applied.
    Returns {model, source} where source is 'local' or 'cloud'."""
    from .settings_store import get_cloud_settings

    local_model = await get_model_assignment(category)
    try:
        cloud = await get_cloud_settings()
        if cloud["cloudMode"] != "local":
            cma = await get_cloud_model_assignment(category)
            if cma:
                return {"model": cma, "source": "cloud"}
    except Exception:  # noqa: BLE001
        pass
    return {"model": local_model, "source": "local"}


async def get_cloud_model_assignment(category: str) -> str:
    settings = read_settings_cached()
    cma = settings.get("cloudModelAssignments")
    if isinstance(cma, dict) and isinstance(cma.get(category), str):
        return cma[category]
    return ""
