"""Live check: chat SSE must arrive incrementally (streaming, not buffered).

Creates a user, logs in, sends a chat request to a local Ollama model and
measures when the first SSE byte arrives vs the last. If the backend buffers
everything until the end, first_byte_s ~= total_s (the old bug). With real
streaming, first_byte_s should be a small fraction of the total.

Uses httpx (a backend dependency) — urllib's buffered reader masks streaming.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3162"
MODEL = sys.argv[2] if len(sys.argv) > 2 else "qwen3:8b"


async def main() -> None:
    async with httpx.AsyncClient(timeout=15) as c:
        uname = f"streamtest{int(time.time())}"
        await c.post(
            f"{BASE}/api/auth/register",
            json={"username": uname, "password": "testpass123"},
        )
        r = await c.post(
            f"{BASE}/api/auth/login",
            json={"username": uname, "password": "testpass123"},
        )
        token = r.json()["token"]
    print(f"logged in as {uname}")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": "Count from 1 to 30, one number per line."}],
    }

    start = time.time()
    first_byte = None
    n_chunks = 0
    first_chunk_at = None
    last_chunk_at = 0.0
    done = False
    error = None

    async with httpx.AsyncClient(timeout=None) as c:
        async with c.stream("POST", f"{BASE}/api/chat", json=body, headers=headers) as res:
            ctype = res.headers.get("content-type", "")
            print(f"status {res.status_code}, content-type: {ctype}")
            if "text/event-stream" not in ctype:
                print("FAIL: response is not SSE")
                sys.exit(1)
            buf = ""
            async for piece in res.aiter_text():
                now = time.time() - start
                if first_byte is None:
                    first_byte = now
                    print(f"first byte at {now:.2f}s")
                buf += piece
                while "\n\n" in buf:
                    raw, buf = buf.split("\n\n", 1)
                    for line in raw.splitlines():
                        if not line.startswith("data:"):
                            continue
                        try:
                            evt = json.loads(line[5:].strip())
                        except json.JSONDecodeError:
                            continue
                        if evt.get("type") == "chunk":
                            n_chunks += 1
                            if first_chunk_at is None:
                                first_chunk_at = now
                            last_chunk_at = now
                        elif evt.get("type") == "done":
                            done = True
                        elif evt.get("type") == "error":
                            error = evt.get("error")

    total = time.time() - start
    print(f"\ndone={done}, chunks={n_chunks}, total={total:.2f}s")

    if error:
        print(f"FAIL: error event: {error}")
        sys.exit(1)
    if not done:
        print("FAIL: stream ended without a done event")
        sys.exit(1)
    if n_chunks < 5:
        print("FAIL: too few chunks — streaming not incremental")
        sys.exit(1)

    spread = (last_chunk_at - (first_chunk_at or 0))
    print(f"chunk spread: {spread:.2f}s (first chunk {first_chunk_at:.2f}s -> last {last_chunk_at:.2f}s)")
    if first_byte is None or first_byte > max(total * 0.5, 3.0):
        print("FAIL: first byte arrived late — backend is still buffering")
        sys.exit(1)

    print("PASS: streaming is incremental")


asyncio.run(main())
