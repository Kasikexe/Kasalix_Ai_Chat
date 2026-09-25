"""Live agent-mode smoke test against a running Python backend.

Usage: python tests/live_agent_check.py <base_url> <workspace_path>
"""
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

# Self-signed dev certs — skip verification
_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE

base = sys.argv[1].rstrip("/")
workspace = sys.argv[2]

def req(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {}
    if data:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=60, context=_CTX) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")

# 1. Register
status, body = req("POST", "/api/auth/register", {"username": "agenttest", "password": "agent-pass"})
if status not in (200, 201):
    status, body = req("POST", "/api/auth/login", {"username": "agenttest", "password": "agent-pass"})
token = json.loads(body)["token"]
print(f"[auth] register/login -> {status}, token ok")

# 2. Agent chat request (SSE stream)
payload = {
    "model": "qwen3:8b",
    "mode": "agent",
    "workspacePath": workspace,
    "autoApply": True,
    "planningEnabled": False,
    "planMode": "off",
    "toolPermission": "auto-edit",
    "messages": [
        {"role": "user", "content": "Create a file called hello.txt in this workspace containing the text: Hello from the Python agent. Then run git status and report what changed."}
    ],
}
data = json.dumps(payload).encode()
headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
# Probe: PY redirects /api/chat -> /api/chat/ (307); TS serves /api/chat exactly.
probe_status, _ = req("POST", "/api/chat", payload, token)
chat_path = "/api/chat" if probe_status == 200 else "/api/chat/"
r = urllib.request.Request(base + chat_path, data=data, method="POST", headers=headers)

event_counts: dict[str, int] = {}
sample: dict[str, str] = {}
try:
    with urllib.request.urlopen(r, timeout=180, context=_CTX) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data: "):
                continue
            try:
                evt = json.loads(line[6:])
            except json.JSONDecodeError:
                continue
            et = evt.get("type", "?")
            event_counts[et] = event_counts.get(et, 0) + 1
            if et in ("agent_tool", "agent_command", "agent_approval_request", "agent_question") and et not in sample:
                sample[et] = json.dumps(evt)[:400]
            if et == "done":
                sample["done"] = json.dumps(evt)[:200]
            if et == "chunk" and len(sample.get("chunks", "")) < 1500:
                sample["chunks"] = sample.get("chunks", "") + evt.get("content", evt.get("text", ""))
except Exception as e:  # noqa: BLE001
    print(f"[error] stream failed: {e}")
    sys.exit(1)

print(f"\n[events] {json.dumps(event_counts, indent=2)}")
for k, v in sample.items():
    print(f"\n--- sample {k} ---\n{v}")

# 3. Verify the file was actually created by the agent
target = os.path.join(workspace, "hello.txt")
if os.path.exists(target):
    print(f"\n[verify] hello.txt EXISTS: {open(target, encoding='utf-8').read()!r}")
else:
    print("\n[verify] hello.txt NOT created")
    sys.exit(2)
print("[PASS] agent mode end-to-end OK")