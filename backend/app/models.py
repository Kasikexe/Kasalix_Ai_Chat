"""Shared types — mirrors backend/src/types.ts.

The TS backend works with loose JSON objects end-to-end; the Python port keeps
the same shapes as plain dicts (with TypedDicts for documentation and a few
constructors) so the API payload stays byte-compatible.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

Role = Literal["user", "assistant", "system"]
ConversationMode = Literal["chat", "agent"]


class Message(TypedDict, total=False):
    role: Role
    content: str
    timestamp: float
    thinking: str  # reasoning text from qwen3/deepseek-r1 style models


class AgentResumeState(TypedDict, total=False):
    history: list[dict[str, str]]
    pendingPlan: str


class Conversation(TypedDict, total=False):
    id: str
    title: str
    messages: list[Message]
    model: str
    mode: ConversationMode
    workspacePath: str | None
    agentState: AgentResumeState | None
    ownerId: str
    createdAt: float
    updatedAt: float


class OllamaModel(TypedDict, total=False):
    name: str
    size: float
    modified_at: str
    digest: str
    supportsThinking: bool
    details: dict[str, Any]


class ToolLoopMessage(TypedDict, total=False):
    """A message inside the model-driven tool-calling loop (transient)."""

    role: str
    content: str
    tool_calls: list[dict[str, Any]]


def make_message(role: Role, content: str, **extra: Any) -> Message:
    msg: Message = {"role": role, "content": content}
    msg.update(extra)  # type: ignore[typeddict-item]
    return msg
