"""Conversation-owned, loopback-only static previews for workspace files."""
from __future__ import annotations

import asyncio
import functools
import http.server
import os
import threading
from typing import Callable
from urllib.parse import quote, unquote, urlsplit

from .utils import PROTECTED_DIRS, is_protected_path


class _Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, root: str, workspace: str, is_rules: Callable[[str, str], bool], **kwargs):
        self.preview_root = os.path.realpath(root)
        self.workspace = workspace
        self.is_rules = is_rules
        super().__init__(*args, directory=self.preview_root, **kwargs)

    def log_message(self, *_args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_head(self):
        try:
            raw = unquote(urlsplit(self.path).path, errors="strict").replace("\\", "/")
            parts = [part for part in raw.split("/") if part]
            if any(part in (".", "..") or part.startswith(".") or "\x00" in part for part in parts):
                self.send_error(403)
                return None
            target = os.path.realpath(super().translate_path(self.path))
            if os.path.isdir(target):
                target = os.path.realpath(os.path.join(target, "index.html"))
                if not os.path.isfile(target):
                    self.send_error(403, "Directory listings are disabled")
                    return None
            if os.path.commonpath([self.preview_root, target]) != self.preview_root:
                self.send_error(403)
                return None
            actual_parts = os.path.relpath(target, self.preview_root).replace("\\", "/").split("/")
            if any(part.startswith(".") or part.lower() in {p.lower() for p in PROTECTED_DIRS} for part in actual_parts):
                self.send_error(403)
                return None
            if (is_protected_path(self.workspace, target) or self.is_rules(self.workspace, target)
                    or os.path.basename(target).lower() in {"agent_rules.md", ".agent-rules", ".agent-rules.md"}):
                self.send_error(403)
                return None
        except (ValueError, OSError, UnicodeError):
            self.send_error(403)
            return None
        return super().send_head()


class StaticPreview:
    def __init__(self, workspace: str, file_path: str, is_rules: Callable[[str, str], bool]):
        self.root = os.path.realpath(os.path.dirname(file_path))
        handler = functools.partial(_Handler, root=self.root, workspace=workspace, is_rules=is_rules)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/{quote(os.path.basename(file_path))}"
        self.closed = False

    async def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            await asyncio.to_thread(self.server.shutdown)
        finally:
            self.server.server_close()
            await asyncio.to_thread(self.thread.join, 2)
