"""Run one plugin action in a restricted, disposable Linux container.

Only JSON crosses the boundary. No host folders, credentials, Docker socket,
or network are exposed to the container. Host-side code must independently
enforce permissions before applying any returned storage changes.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import uuid
from typing import Any

IMAGE = "python:3.12-slim"
MAX_OUTPUT = 128_000
TIMEOUT = 15
_slots = asyncio.Semaphore(4)

BOOTSTRAP = r'''
import asyncio, inspect, json, sys

request = json.loads(sys.stdin.read())
protocol = sys.stdout
sys.stdout = sys.stderr  # Plugin print() calls must not corrupt the JSON response.
permissions = set(request["permissions"])
state = request["storage"]
writes = {}
deletes = []

class Storage:
    def get(self, key, default=None):
        if "storage.read" not in permissions:
            raise PermissionError("storage.read was not granted")
        return state.get(key, default)
    def set(self, key, value):
        if "storage.write" not in permissions:
            raise PermissionError("storage.write was not granted")
        if not isinstance(key, str) or not key or len(key) > 128:
            raise ValueError("Invalid storage key")
        state[key] = value
        writes[key] = value
        if key in deletes: deletes.remove(key)
    def delete(self, key):
        if "storage.write" not in permissions:
            raise PermissionError("storage.write was not granted")
        if not isinstance(key, str) or not key or len(key) > 128:
            raise ValueError("Invalid storage key")
        state.pop(key, None)
        writes.pop(key, None)
        if key not in deletes: deletes.append(key)

class API:
    storage = Storage()

try:
    namespace = {"__name__": "kasalix_plugin"}
    exec(compile(request["source"], "plugin.py", "exec"), namespace)
    handler = namespace.get("handle")
    if not callable(handler):
        raise ValueError("Plugin must define handle(action, payload, api)")
    result = handler(request["action"], request["payload"], API())
    if inspect.isawaitable(result): result = asyncio.run(result)
    print(json.dumps({"ok": True, "result": result, "writes": writes, "deletes": deletes}, allow_nan=False), file=protocol)
except Exception as error:
    print(json.dumps({"ok": False, "error": str(error)[:500]}), file=protocol)
'''


class SandboxError(RuntimeError):
    pass


async def _limited_read(stream: asyncio.StreamReader, limit: int) -> bytes:
    data = bytearray()
    while True:
        chunk = await stream.read(8192)
        if not chunk:
            return bytes(data)
        data.extend(chunk)
        if len(data) > limit:
            raise SandboxError("Plugin output exceeded the limit")


async def run_action(source: str, action: str, payload: dict[str, Any], permissions: list[str], storage: dict[str, Any]) -> dict[str, Any]:
    docker = shutil.which("docker")
    if not docker:
        raise SandboxError("Docker is not installed or is not on the server PATH")
    name = "kasalix-plugin-" + uuid.uuid4().hex
    # Do not let a request or a plugin supply Docker flags, an image, or mounts.
    command = [docker, "run", "--rm", "--interactive", "--name", name, "--pull", "never",
               "--network", "none", "--read-only", "--cap-drop", "ALL",
               "--security-opt", "no-new-privileges=true", "--pids-limit", "32",
               "--memory", "128m", "--memory-swap", "128m", "--cpus", "0.5",
               "--user", "65534:65534", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
               IMAGE, "python", "-I", "-c", BOOTSTRAP]
    request = json.dumps({"source": source, "action": action, "payload": payload,
                          "permissions": permissions, "storage": storage}, allow_nan=False).encode("utf-8")
    async with _slots:
        process = None
        try:
            process = await asyncio.create_subprocess_exec(*command, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                creationflags=getattr(__import__('subprocess'), 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0)

            async def exchange():
                process.stdin.write(request)
                await process.stdin.drain()
                process.stdin.close()
                out, err, code = await asyncio.gather(_limited_read(process.stdout, MAX_OUTPUT),
                    _limited_read(process.stderr, 16_000), process.wait())
                return out, err, code

            out, err, code = await asyncio.wait_for(exchange(), timeout=TIMEOUT)
            if code != 0:
                # Docker errors can contain host paths. Return a bounded generic
                # message instead of handing raw daemon output to remote users.
                raise SandboxError("Plugin container failed; check Docker and the required local image")
            try:
                result = json.loads(out)
            except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
                raise SandboxError("Plugin returned invalid output") from error
            if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
                raise SandboxError("Plugin returned invalid output")
            if not result["ok"]:
                raise SandboxError("Plugin action failed: " + str(result.get("error", "unknown error"))[:500])
            return result
        except (asyncio.TimeoutError, TimeoutError) as error:
            raise SandboxError("Plugin action timed out") from error
        except OSError as error:
            raise SandboxError("Could not start the Docker runtime") from error
        finally:
            if process and process.returncode is None:
                try: process.kill()
                except ProcessLookupError: pass
                try: await process.wait()
                except ProcessLookupError: pass
            # Killing the Docker CLI does not necessarily stop its container.
            try:
                cleanup = await asyncio.create_subprocess_exec(docker, "rm", "--force", name,
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                    creationflags=getattr(__import__('subprocess'), 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0)
                await asyncio.wait_for(cleanup.wait(), timeout=3)
            except (OSError, asyncio.TimeoutError):
                if 'cleanup' in locals() and cleanup.returncode is None:
                    try: cleanup.kill()
                    except ProcessLookupError: pass
