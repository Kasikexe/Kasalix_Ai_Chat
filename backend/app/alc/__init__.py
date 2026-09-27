"""ALC — Advanced Learning Cycle (v0.13.0, Phase 2: chat + Koding).

A software-orchestrated reasoning and information-gathering cycle wrapped
around the LLM. The model is asked what it needs to know, the controller
retrieves from documentation / (later) project knowledge / the web, judges what
is relevant, keeps a small bounded scratchpad, and only then answers.

Design: see docs/ALC_DESIGN.md. Nothing here touches model weights — ALC is
ordinary orchestration around the existing chat pipeline.

Normal mode is untouched: nothing in this package runs unless the client sends
``alc: true`` on a chat request.
"""

from __future__ import annotations

from .controller import run_alc_gather, run_alc_turn
from .events import ALC_EVENT_TYPES, emit_alc, emit_alc_notice

__all__ = [
    "ALC_EVENT_TYPES",
    "emit_alc",
    "emit_alc_notice",
    "run_alc_gather",
    "run_alc_turn",
]
