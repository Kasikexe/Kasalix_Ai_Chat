import asyncio
import json

import pytest

from app.services.plugins import manager


def manifest():
    return {
        "id": "sample-ui", "name": "Sample", "version": "1.0.0", "kind": "ui",
        "modes": [{"id": "sample", "name": "Sample mode", "baseMode": "chat",
                   "theme": {"accent": "#123456", "background": "#111111"},
                   "welcome": {"title": "Choose", "items": [{"id": "first", "label": "First", "message": "Hello"}]}}],
    }


@pytest.mark.parametrize("change", [
    lambda data: data.update(entry="index.py"),
    lambda data: data["modes"][0].update(theme={"accent": "url(https://example.invalid)"}),
    lambda data: data["modes"][0].update(baseMode="other"),
    lambda data: data["modes"].append(data["modes"][0]),
    lambda data: data["modes"][0]["welcome"].update(items=[{"id": "bad id", "label": "Item"}]),
])
def test_rejects_unsafe_or_invalid_ui_manifests(change):
    data = manifest()
    change(data)
    with pytest.raises(ValueError):
        manager.parse_manifest(json.dumps(data))


def test_local_ui_lifecycle_never_executes_or_deletes_plugin_folder(tmp_path, monkeypatch):
    data_dir = tmp_path / "server-data"
    folder = tmp_path / "external-plugin"
    folder.mkdir()
    file = folder / "plugin.json"
    file.write_text(json.dumps(manifest()), encoding="utf-8")
    marker = tmp_path / "executed"
    (folder / "index.py").write_text(f"open({str(marker)!r}, 'w').write('executed')", encoding="utf-8")
    monkeypatch.setattr(manager, "get_data_dir", lambda: data_dir)

    async def run():
        plugin = await manager.install_local_ui(str(folder))
        assert plugin["manifest"]["kind"] == "ui"
        assert [m["id"] for m in await manager.list_plugin_modes()] == ["plugin:sample-ui:sample"]
        await manager.set_plugin_enabled("sample-ui", False)
        assert await manager.list_plugin_modes() == []
        await manager.set_plugin_enabled("sample-ui", True)
        updated = manifest()
        updated["modes"][0]["name"] = "Updated"
        file.write_text(json.dumps(updated), encoding="utf-8")
        await manager.update_plugin("sample-ui")
        assert (await manager.list_plugin_modes())[0]["name"] == "Updated"
        updated["id"] = "different"
        file.write_text(json.dumps(updated), encoding="utf-8")
        with pytest.raises(ValueError, match="id cannot change"):
            await manager.update_plugin("sample-ui")
        await manager.uninstall_plugin("sample-ui")
        assert await manager.list_plugin_modes() == []

    asyncio.run(run())
    assert not marker.exists()
    assert file.exists() and folder.is_dir()


def test_local_loader_rejects_executable_plugin(tmp_path, monkeypatch):
    monkeypatch.setattr(manager, "get_data_dir", lambda: tmp_path / "data")
    (tmp_path / "plugin.json").write_text(json.dumps({"id": "sample", "name": "Sample", "version": "1"}), encoding="utf-8")
    with pytest.raises(ValueError, match="Only data-only"):
        asyncio.run(manager.install_local_ui(str(tmp_path)))


def test_catalog_ui_plugin_does_not_execute_entry(tmp_path, monkeypatch):
    monkeypatch.setattr(manager, "get_data_dir", lambda: tmp_path / "data")
    marker = tmp_path / "executed"

    async def resolve(_spec):
        return "main"

    async def tree(_spec):
        return ["plugin.json", "index.py"]

    async def download(_owner, _repo, _branch, file):
        return json.dumps(manifest()) if file == "plugin.json" else f"open({str(marker)!r}, 'w').write('executed')"

    monkeypatch.setattr(manager, "resolve_repo", resolve)
    monkeypatch.setattr(manager, "fetch_repo_tree", tree)
    monkeypatch.setattr(manager, "download_raw_file", download)

    async def run():
        await manager.install_plugin("owner/repository")
        assert len(await manager.list_plugin_modes()) == 1
        await manager.set_plugin_enabled("sample-ui", False)
        await manager.set_plugin_enabled("sample-ui", True)
        assert len(await manager.list_plugin_modes()) == 1

    asyncio.run(run())
    assert not marker.exists()
