import asyncio
import json
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.plugins import manager, runtime, sandbox


def plugin_manifest():
    return {"id": "sample-backend", "name": "Sample", "version": "1", "kind": "ui",
            "backend": {"entry": "backend.py", "actions": ["count"], "permissions": ["storage.read", "storage.write"]},
            "modes": [{"id": "main", "name": "Sample", "baseMode": "chat", "welcome": {"title": "Sample", "items": [
                {"id": "run", "label": "Run", "backendAction": "count", "payload": {"increment": 1}}]}}]}


def write_plugin(folder):
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps(plugin_manifest()), encoding="utf-8")
    (folder / "backend.py").write_text("def handle(action, payload, api):\n    return {'ok': True}\n", encoding="utf-8")


def test_bootstrap_enforces_storage_capabilities_for_honest_plugin():
    source = "def handle(action, payload, api):\n    print('debug')\n    n = api.storage.get('n', 0) + 1\n    api.storage.set('n', n)\n    return n\n"
    request = {"source": source, "action": "count", "payload": {}, "storage": {"n": 4}, "permissions": ["storage.read", "storage.write"]}
    result = subprocess.run([sys.executable, "-I", "-c", sandbox.BOOTSTRAP], input=json.dumps(request), text=True, capture_output=True, timeout=5, check=True)
    assert json.loads(result.stdout) == {"ok": True, "result": 5, "writes": {"n": 5}, "deletes": []}
    assert "debug" in result.stderr
    request["permissions"] = []
    result = subprocess.run([sys.executable, "-I", "-c", sandbox.BOOTSTRAP], input=json.dumps(request), text=True, capture_output=True, timeout=5, check=True)
    assert not json.loads(result.stdout)["ok"] and "not granted" in json.loads(result.stdout)["error"]


def test_missing_docker_fails_closed(monkeypatch):
    monkeypatch.setattr(sandbox.shutil, "which", lambda _name: None)
    with pytest.raises(sandbox.SandboxError, match="Docker is not installed"):
        asyncio.run(sandbox.run_action("", "count", {}, [], {}))


def test_backend_only_plugin_can_be_installed_without_a_mode(tmp_path, monkeypatch):
    folder = tmp_path / "plugin"
    write_plugin(folder)
    data = plugin_manifest()
    data["kind"] = "backend"
    data.pop("modes")
    (folder / "plugin.json").write_text(json.dumps(data), encoding="utf-8")
    monkeypatch.setattr(manager, "get_data_dir", lambda: tmp_path / "data")
    async def run():
        plugin = await manager.install_local_ui(str(folder))
        assert plugin["manifest"]["kind"] == "backend"
        assert plugin["backendFingerprint"] and await manager.list_plugin_modes() == []
    asyncio.run(run())


def test_container_command_has_fixed_isolation_and_no_host_mounts(monkeypatch):
    commands = []
    inputs = []

    class Input:
        def write(self, value): inputs.append(value)
        async def drain(self): pass
        def close(self): pass

    class Process:
        def __init__(self, output):
            self.returncode = None
            self.stdin = Input()
            self.stdout = asyncio.StreamReader()
            self.stdout.feed_data(output)
            self.stdout.feed_eof()
            self.stderr = asyncio.StreamReader()
            self.stderr.feed_eof()
        async def wait(self):
            self.returncode = 0
            return 0

    async def create(*args, **_kwargs):
        commands.append(args)
        return Process(b'{"ok":true,"result":"ok","writes":{},"deletes":[]}')

    monkeypatch.setattr(sandbox.shutil, "which", lambda _name: "docker")
    monkeypatch.setattr(sandbox.asyncio, "create_subprocess_exec", create)
    result = asyncio.run(sandbox.run_action("def handle(a,p,api): return 'ok'", "count", {}, [], {}))
    command = commands[0]
    assert result["result"] == "ok"
    assert command[command.index("--network") + 1] == "none"
    assert command[command.index("--user") + 1] == "65534:65534"
    assert "--read-only" in command and "--cap-drop" in command and "--pids-limit" in command
    assert command[command.index("--security-opt") + 1] == "no-new-privileges=true"
    assert "--memory" in command and "--cpus" in command
    assert "--pull" in command and command[command.index("--pull") + 1] == "never"
    assert "--volume" not in command and "--mount" not in command and "--privileged" not in command
    assert json.loads(inputs[0])["source"].startswith("def handle")
    assert commands[-1][1:3] == ("rm", "--force")


def test_timed_out_action_stops_cli_and_removes_container(monkeypatch):
    commands = []
    processes = []

    class Input:
        def write(self, _value): pass
        async def drain(self): pass
        def close(self): pass

    class Process:
        def __init__(self, cleanup):
            self.returncode = None
            self.stdin = Input()
            self.stdout = asyncio.StreamReader()
            self.stderr = asyncio.StreamReader()
            self.done = asyncio.Event()
            if cleanup:
                self.stdout.feed_eof(); self.stderr.feed_eof(); self.done.set()
        async def wait(self):
            await self.done.wait()
            if self.returncode is None: self.returncode = 0
            return self.returncode
        def kill(self):
            self.returncode = -9
            self.done.set()

    async def create(*args, **_kwargs):
        commands.append(args)
        process = Process(args[1] == "rm")
        processes.append(process)
        return process

    monkeypatch.setattr(sandbox, "TIMEOUT", 0.01)
    monkeypatch.setattr(sandbox.shutil, "which", lambda _name: "docker")
    monkeypatch.setattr(sandbox.asyncio, "create_subprocess_exec", create)
    with pytest.raises(sandbox.SandboxError, match="timed out"):
        asyncio.run(sandbox.run_action("", "count", {}, [], {}))
    assert processes[0].returncode == -9
    assert commands[-1][1:3] == ("rm", "--force")


def test_unapproved_and_changed_code_cannot_run_and_storage_is_per_user(tmp_path, monkeypatch):
    folder = tmp_path / "plugin"
    write_plugin(folder)
    monkeypatch.setattr(manager, "get_data_dir", lambda: tmp_path / "data")
    monkeypatch.setattr(runtime, "get_data_dir", lambda: tmp_path / "data")
    seen = []

    async def fake_container(source, action, payload, permissions, storage):
        seen.append((source, action, permissions, storage.copy()))
        return {"ok": True, "result": storage.get("n", 0) + 1, "writes": {"n": storage.get("n", 0) + 1}, "deletes": []}
    monkeypatch.setattr(sandbox, "run_action", fake_container)

    async def run():
        await manager.install_local_ui(str(folder))
        with pytest.raises(PermissionError, match="approval"):
            await runtime.invoke("sample-backend", "count", {}, "alice")
        await manager.set_backend_permissions("sample-backend", True, ["storage.read", "storage.write"])
        assert await runtime.invoke("sample-backend", "count", {}, "alice") == 1
        assert await runtime.invoke("sample-backend", "count", {}, "alice") == 2
        assert await runtime.invoke("sample-backend", "count", {}, "bob") == 1
        assert seen[1][3] == {"n": 1} and seen[2][3] == {}
        await runtime.clear_storage("sample-backend", "alice")
        assert await runtime.invoke("sample-backend", "count", {}, "alice") == 1
        assert await runtime.invoke("sample-backend", "count", {}, "bob") == 2
        (folder / "backend.py").write_text("def handle(action, payload, api): return 'changed'\n", encoding="utf-8")
        with pytest.raises(PermissionError, match="approval"):
            await runtime.invoke("sample-backend", "count", {}, "alice")
        await manager.update_plugin("sample-backend")
        with pytest.raises(PermissionError, match="approval"):
            await runtime.invoke("sample-backend", "count", {}, "alice")
        await manager.set_backend_permissions("sample-backend", False, [])

    asyncio.run(run())


def test_host_rejects_forged_storage_writes_without_permission(tmp_path, monkeypatch):
    folder = tmp_path / "plugin"
    write_plugin(folder)
    monkeypatch.setattr(manager, "get_data_dir", lambda: tmp_path / "data")
    monkeypatch.setattr(runtime, "get_data_dir", lambda: tmp_path / "data")
    async def forged(_source, _action, _payload, _permissions, _storage):
        return {"ok": True, "result": "ok", "writes": {"n": 1}, "deletes": []}
    monkeypatch.setattr(sandbox, "run_action", forged)
    async def run():
        await manager.install_local_ui(str(folder))
        await manager.set_backend_permissions("sample-backend", True, [])
        with pytest.raises(PermissionError, match="storage.write"):
            await runtime.invoke("sample-backend", "count", {}, "alice")
        assert not (tmp_path / "data" / "plugin-storage").exists()
    asyncio.run(run())


@pytest.mark.parametrize("change", ["revoke", "code"])
def test_permission_or_code_change_during_action_discards_result_and_writes(tmp_path, monkeypatch, change):
    folder = tmp_path / "plugin"
    write_plugin(folder)
    monkeypatch.setattr(manager, "get_data_dir", lambda: tmp_path / "data")
    monkeypatch.setattr(runtime, "get_data_dir", lambda: tmp_path / "data")

    async def run():
        started, release = asyncio.Event(), asyncio.Event()
        async def delayed(_source, _action, _payload, _permissions, _storage):
            started.set()
            await release.wait()
            return {"ok": True, "result": "ok", "writes": {"n": 1}, "deletes": []}
        monkeypatch.setattr(sandbox, "run_action", delayed)
        await manager.install_local_ui(str(folder))
        await manager.set_backend_permissions("sample-backend", True, ["storage.read", "storage.write"])
        task = asyncio.create_task(runtime.invoke("sample-backend", "count", {}, "alice"))
        await started.wait()
        if change == "revoke":
            await manager.set_backend_permissions("sample-backend", False, [])
        else:
            (folder / "backend.py").write_text("def handle(action, payload, api): return 'changed'\n", encoding="utf-8")
        release.set()
        with pytest.raises(PermissionError, match="changed"):
            await task
        assert not (tmp_path / "data" / "plugin-storage").exists()
    asyncio.run(run())


def test_backend_endpoints_require_session_and_local_permission_approval(tmp_path, monkeypatch):
    folder = tmp_path / "plugin"
    write_plugin(folder)
    monkeypatch.setattr(manager, "get_data_dir", lambda: tmp_path / "data")
    monkeypatch.setattr(runtime, "get_data_dir", lambda: tmp_path / "data")
    local = TestClient(app, client=("127.0.0.1", 50000))
    remote = TestClient(app, client=("192.0.2.3", 50000))
    assert local.post("/api/plugins/install-local-ui", json={"path": str(folder)}).status_code == 200
    assert remote.post("/api/plugins/sample-backend/actions/count", json={}).status_code == 401
    assert remote.delete("/api/plugins/sample-backend/storage").status_code == 401
    assert remote.get("/api/plugins/sample-backend/permissions").status_code == 403
    assert local.post("/api/plugins/sample-backend/permissions", headers={"Origin": "https://example.invalid"}, json={"approved": True}).status_code == 403
    assert local.post("/api/plugins/sample-backend/permissions", json={"approved": True, "grants": ["storage.write"]}).status_code == 400
    info = local.get("/api/plugins/sample-backend/permissions").json()
    assert not info["approved"] and info["permissions"] == ["storage.read", "storage.write"]
    assert local.post("/api/plugins/sample-backend/permissions", json={"approved": True, "grants": ["storage.read"]}).status_code == 200
    assert local.get("/api/plugins/sample-backend/permissions").json()["granted"] == ["storage.read"]
    import app.routes.plugins as routes
    monkeypatch.setattr(routes, "session_authenticated", lambda _request: True)
    monkeypatch.setattr(routes, "user_id_from_request", lambda _request: "alice")
    async def fake_container(_source, _action, payload, permissions, storage):
        assert permissions == ["storage.read"] and storage == {}
        return {"ok": True, "result": payload, "writes": {}, "deletes": []}
    monkeypatch.setattr(sandbox, "run_action", fake_container)
    invoked = remote.post("/api/plugins/sample-backend/actions/count", json={"value": 7})
    assert invoked.status_code == 200 and invoked.json()["result"] == {"value": 7}
    assert remote.post("/api/plugins/sample-backend/actions/unknown", json={}).status_code == 400
    assert remote.delete("/api/plugins/sample-backend/storage").status_code == 200
    assert local.post("/api/plugins/sample-backend/permissions", json={"approved": False}).status_code == 200
    assert remote.post("/api/plugins/sample-backend/actions/count", json={}).status_code == 403


def test_legacy_plugin_is_not_executed_on_enable(tmp_path, monkeypatch):
    monkeypatch.setattr(manager, "get_data_dir", lambda: tmp_path / "data")
    marker = tmp_path / "ran"
    folder = tmp_path / "legacy"
    folder.mkdir()
    (folder / "index.py").write_text(f"open({str(marker)!r}, 'w').write('executed')", encoding="utf-8")
    plugin = {"id": "legacy", "manifest": {"kind": "tool", "entry": "index.py"}, "enabled": True}
    assert asyncio.run(manager.load_plugin_entry(plugin, {"dirOverride": str(folder)})) == []
    assert not marker.exists()
