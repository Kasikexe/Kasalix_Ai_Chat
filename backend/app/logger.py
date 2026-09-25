"""Logger service — mirrors backend/src/services/logger.ts.

Structured logging with security filtering. NEVER logs passwords, password
hashes, session tokens, or chat messages (chat logging requires explicit
opt-in via LOG_CHAT_MESSAGES).
"""

import datetime as _dt
import os
import re
import sys

# Windows consoles default to cp1252 — force UTF-8 so arrows (→), em dashes,
# and other non-cp1252 glyphs in log lines never crash a print (which would
# otherwise bubble up into the SSE stream as an error).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

LOG_CHAT = os.environ.get("LOG_CHAT_MESSAGES") == "true"
DEBUG_ON = os.environ.get("NODE_ENV") != "production" or os.environ.get("LOG_DEBUG") == "true"

# Block anything that looks like a password/hash/token
_SENSITIVE = re.compile(r"(passw(or)?d|secret|token|hash|auth|session)", re.IGNORECASE)
_BCRYPT = re.compile(r"^(\$2[aby]\$|\$argon2)")


def _fmt_ts() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _sanitize(arg: object) -> str:
    s = str(arg)
    if _SENSITIVE.search(s) and (len(s) > 20 or _BCRYPT.match(s)):
        return "[REDACTED]"
    return s


def info(*args: object) -> None:
    print(f"[{_fmt_ts()}] [INFO]", *[_sanitize(a) for a in args], file=sys.stdout, flush=True)


def warn(*args: object) -> None:
    print(f"[{_fmt_ts()}] [WARN]", *[_sanitize(a) for a in args], file=sys.stderr, flush=True)


def error(*args: object) -> None:
    print(f"[{_fmt_ts()}] [ERROR]", *[_sanitize(a) for a in args], file=sys.stderr, flush=True)


def debug(*args: object) -> None:
    if DEBUG_ON:
        print(f"[{_fmt_ts()}] [DEBUG]", *[_sanitize(a) for a in args], file=sys.stdout, flush=True)


def chat(event: str, meta: dict | None = None) -> None:
    """Log chat-related events. Only logs if LOG_CHAT_MESSAGES is enabled.
    Never logs actual message content — just metadata."""
    if not LOG_CHAT:
        return
    print(f"[{_fmt_ts()}] [CHAT] {event}", (str(meta) if meta else ""), file=sys.stdout, flush=True)
