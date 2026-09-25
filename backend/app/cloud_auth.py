"""Cloud API-key verification.

Verified against ollama.com: a POST to ``/api/chat`` with a model that does not
exist is the only trustworthy auth probe, because the cloud checks auth BEFORE
model lookup. That means a VALID key yields 404 (model not found) or 200, while
a DEAD key yields 401/403. GET endpoints lie: ``/v1/models`` is public and
always returns 200, and ``/api/ps`` 401s even valid keys. Relying on those used
to disable cloud routing for everyone.

The chat pipeline and the "Test Connection" button in the Server app both use
:func:`verify_cloud_key` so the two can never drift apart.
"""

from __future__ import annotations

import time

import httpx

from .logger import info as log_info, warn as log_warn

# A model name that cannot exist on any real cloud account. The cloud answers
# 404 for it once auth has passed — which is exactly what proves the key works.
AUTH_PROBE_MODEL = "auth-probe-check"

# How long to wait for the auth probe. The chat pipeline tolerates a slow
# provider; the interactive "Test Connection" button uses a shorter budget.
DEFAULT_PROBE_TIMEOUT = 15.0
INTERACTIVE_PROBE_TIMEOUT = 10.0
MODELS_TIMEOUT = 5.0

AUTH_REJECTED_CODES = (401, 403)
PROBE_OK_CODES = (200, 404)


async def verify_cloud_key(
    endpoint: str,
    api_key: str,
    *,
    timeout: float = DEFAULT_PROBE_TIMEOUT,
    include_models: bool = False,
) -> dict:
    """Probe ``endpoint`` with ``api_key`` and report a structured result.

    Never raises: transport problems come back as ``ok=False`` with
    ``kind="endpoint"``. ``kind`` is one of ``endpoint`` (unreachable / not
    configured), ``key`` (nothing entered), ``auth`` (the cloud rejected the
    key) or ``service`` (the cloud itself answered with an error).
    """
    base = (endpoint or "").strip().rstrip("/")
    key = (api_key or "").strip()
    if not base:
        return {"ok": False, "kind": "endpoint", "message": "No cloud endpoint configured."}
    if not key:
        return {"ok": False, "kind": "key", "message": "No API key entered."}

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.post(
                f"{base}/api/chat",
                headers=headers,
                json={
                    "model": AUTH_PROBE_MODEL,
                    "messages": [{"role": "user", "content": "ping"}],
                    "stream": False,
                },
            )
    except Exception as e:  # noqa: BLE001 — any transport failure means unreachable
        # httpx raises connect errors with an EMPTY str(), which would surface
        # to the user as "Cannot reach https://ollama.com — ". Fall back to the
        # exception type so the failure is always actionable.
        detail = str(e).strip() or type(e).__name__
        log_warn(f"[cloud-auth] Probe failed for {base}: {detail}")
        return {
            "ok": False,
            "kind": "endpoint",
            "message": f"Cannot reach the cloud endpoint {base} ({detail})",
        }

    latency_ms = int((time.monotonic() - started) * 1000)

    if res.status_code in AUTH_REJECTED_CODES:
        return {
            "ok": False,
            "kind": "auth",
            "status": res.status_code,
            "latencyMs": latency_ms,
            "message": (
                f"Cloud rejected the API key ({res.status_code}) — "
                "it may be invalid, expired or revoked."
            ),
        }
    # 404 is the EXPECTED success signal (auth passed, fake model not found).
    # 200 also means auth passed. Anything else is a service problem.
    if res.status_code not in PROBE_OK_CODES:
        return {
            "ok": False,
            "kind": "service",
            "status": res.status_code,
            "latencyMs": latency_ms,
            "message": f"Cloud endpoint answered {res.status_code} instead of accepting the key.",
        }

    result: dict = {
        "ok": True,
        "status": res.status_code,
        "latencyMs": latency_ms,
        "message": "API key verified — the cloud endpoint accepted it.",
    }
    if include_models:
        model_count = await _count_models(base, headers)
        if model_count is not None:
            result["modelCount"] = model_count
    return result


async def _count_models(base: str, headers: dict) -> int | None:
    """Best-effort count of models the endpoint advertises.

    Purely informational — a failure here must never turn a verified key into a
    failure, since ``/v1/models`` is a public endpoint anyway.
    """
    try:
        async with httpx.AsyncClient(timeout=MODELS_TIMEOUT) as client:
            res = await client.get(f"{base}/v1/models", headers=headers)
        if res.status_code >= 400:
            return None
        data = res.json()
        for bucket in ("data", "models"):
            items = data.get(bucket)
            if isinstance(items, list):
                log_info(f"[cloud-auth] Endpoint advertises {len(items)} models")
                return len(items)
    except Exception as e:  # noqa: BLE001
        log_warn(f"[cloud-auth] Model listing skipped: {e}")
    return None
