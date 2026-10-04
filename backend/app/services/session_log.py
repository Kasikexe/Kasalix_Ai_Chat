"""Session Log — append-only event stream for Koding agent runs.

Every token the model sees is recorded. This is the source of truth for
trajectory view, resume, fork, and audit. Follows DeepSeek Harness's
principle: "Model-visible means recorded."
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import get_data_dir
from ..logger import error as log_error

SESSION_EVENT_TYPES = (
    "run:start",
    "run:end",
    "turn:start",
    "turn:end",
    "message",
    "tool:call",
    "tool:result",
    "plan",
    "plan:update",
    "verify",
    "thinking",
    "error",
    "stage",
)


class SessionLog:
    """Append-only JSONL writer for a single agent run."""

    def __init__(self, run_id: str | None = None) -> None:
        import random

        self.run_id = run_id or f"run-{int(time.time() * 1000)}-{''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=6))}"
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.seq = 0
        data_dir = get_data_dir()
        self.file_path = str(Path(data_dir) / "session-logs" / f"{self.run_id}.jsonl")

    async def init(self) -> None:
        """Initialize the log file and write run:start event."""
        try:
            os.makedirs(os.path.dirname(self.file_path), exist_ok=True)
            await self.append({"ts": self.started_at, "type": "run:start", "meta": {"runId": self.run_id}})
        except Exception as e:  # noqa: BLE001
            log_error(f"[session-log] Failed to init: {e}")

    async def append(self, event: dict[str, Any]) -> None:
        """Append an event to the log file. Fire-and-forget — never blocks the pipeline."""
        self.seq += 1
        full = {**event, "seq": self.seq}
        try:
            with open(self.file_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(full, ensure_ascii=False) + "\n")
        except Exception as e:  # noqa: BLE001
            log_error(f"[session-log] Failed to append: {e}")

    async def log_message(self, role: str, content: str, meta_visible: bool = True) -> None:
        """Record a message the model saw (or will see)."""
        truncated = content[:50_000] + "\n...[truncated in log]" if len(content) > 50_000 else content
        await self.append(
            {
                "ts": datetime.now(timezone.utc).isoformat(),
                "type": "message",
                "role": role,
                "content": truncated,
                "modelVisible": meta_visible,
            }
        )

    async def log_tool_call(self, tool: str, args: dict[str, Any]) -> None:
        """Record a tool call the model made."""
        await self.append(
            {
                "ts": datetime.now(timezone.utc).isoformat(),
                "type": "tool:call",
                "label": tool,
                "content": json.dumps({"tool": tool, "args": args}, ensure_ascii=False),
            }
        )

    async def log_tool_result(self, tool: str, output: str, ok: bool) -> None:
        """Record a tool result fed back to the model."""
        truncated = output[:20_000] + "\n...[truncated in log]" if len(output) > 20_000 else output
        await self.append(
            {
                "ts": datetime.now(timezone.utc).isoformat(),
                "type": "tool:result",
                "label": tool,
                "content": truncated,
                "meta": {"ok": ok},
            }
        )

    async def log_plan(self, plan: str, meta: dict[str, Any] | None = None) -> None:
        """Record a plan the model created."""
        await self.append(
            {
                "ts": datetime.now(timezone.utc).isoformat(),
                "type": "plan",
                "content": plan,
                "meta": meta,
            }
        )

    async def log_plan_update(self, update: str, meta: dict[str, Any] | None = None) -> None:
        """Record a plan update (step completed, step added)."""
        await self.append(
            {
                "ts": datetime.now(timezone.utc).isoformat(),
                "type": "plan:update",
                "content": update,
                "meta": meta,
            }
        )

    async def log_verify(self, command: str, output: str, passed: bool) -> None:
        """Record a verification run."""
        truncated = output[:5_000] + "\n...[truncated]" if len(output) > 5_000 else output
        await self.append(
            {
                "ts": datetime.now(timezone.utc).isoformat(),
                "type": "verify",
                "label": command,
                "content": truncated,
                "meta": {"passed": passed},
            }
        )

    async def log_stage(self, stage: str) -> None:
        """Record a stage change."""
        await self.append(
            {"ts": datetime.now(timezone.utc).isoformat(), "type": "stage", "label": stage}
        )

    async def end(self) -> None:
        """Record the end of a run."""
        await self.append(
            {"ts": datetime.now(timezone.utc).isoformat(), "type": "run:end", "meta": {"runId": self.run_id}}
        )

    async def read_all(self) -> list[dict[str, Any]]:
        """Read all events from the log file."""
        try:
            with open(self.file_path, "r", encoding="utf-8") as f:
                lines = [ln for ln in f.read().split("\n") if ln.strip()]
            return [json.loads(ln) for ln in lines]
        except OSError:
            return []

    async def rebuild_history(self) -> list[dict[str, str]]:
        """Reconstruct the model-visible history from the log."""
        messages: list[dict[str, str]] = []
        for e in await self.read_all():
            if e.get("type") == "message" and e.get("role") and e.get("content"):
                messages.append({"role": e["role"], "content": e["content"]})
        return messages

    def get_run_id(self) -> str:
        return self.run_id

    def get_file_path(self) -> str:
        return self.file_path


async def list_session_logs() -> list[dict[str, str]]:
    """List all session log files, sorted by most recent first."""
    try:
        log_dir = Path(get_data_dir()) / "session-logs"
        if not log_dir.is_dir():
            return []
        logs: list[dict[str, str]] = []
        for f in log_dir.iterdir():
            if not f.name.endswith(".jsonl"):
                continue
            logs.append(
                {
                    "runId": f.name[: -len(".jsonl")],
                    "filePath": str(f),
                    "mtime": datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc).isoformat(),
                }
            )
        return sorted(logs, key=lambda x: x["mtime"], reverse=True)
    except OSError:
        return []


async def read_session_log(run_id: str) -> list[dict[str, Any]]:
    """Read a specific session log by run ID."""
    file_path = Path(get_data_dir()) / "session-logs" / f"{run_id}.jsonl"
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            lines = [ln for ln in f.read().split("\n") if ln.strip()]
        return [json.loads(ln) for ln in lines]
    except OSError:
        return []