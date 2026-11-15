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


def test_scoped_extraction_saves_user_context_only_when_memory_is_enabled(tmp_path, monkeypatch):
    from app import extractor, memory

    monkeypatch.setattr(memory, "get_data_dir", lambda: tmp_path)
    scope = memory.plugin_memory_id("owner", "plugin:sample:mode", "first")
    other_scope = memory.plugin_memory_id("owner", "plugin:sample:mode", "second")
    prompts = []

    async def resolved(_role):
        return {"model": "test", "source": "local"}

    async def stream(_model, messages, on_chunk, _opts):
        prompts.append(messages[0]["content"])
        on_chunk('{"changes":{"Context":{"favorite":"blue"}}}')

    monkeypatch.setattr(extractor, "get_resolved_model", resolved)
    monkeypatch.setattr(extractor, "stream_chat", stream)

    async def run():
        await memory.update_memory("owner", {"enabled": True})
        await memory.update_memory(scope, {"enabled": True})
        await extractor.extract_memory_from_turn(scope, "My favorite is blue.", "owner")
        assert (await memory.get_memory(scope))["categories"]["Context"]["favorite"] == "blue"
        assert (await memory.get_memory(other_scope))["categories"] == {}
        assert "fictional" in prompts[0] and "Do not infer" in prompts[0]
        await memory.update_memory(scope, {"categories": {}})
        await memory.update_memory("owner", {"enabled": False})
        await extractor.extract_memory_from_turn(scope, "My favorite is blue.", "owner")
        assert (await memory.get_memory(scope))["categories"] == {}

    asyncio.run(run())


def test_chat_pipeline_uses_only_the_selected_memory_scope(tmp_path, monkeypatch):
    from app import memory, pipeline

    monkeypatch.setattr(memory, "get_data_dir", lambda: tmp_path)
    seen = []

    async def settings():
        return {"cloudMode": "local", "cloudApiKey": "", "cloudEndpoint": ""}
    async def resolved(_role):
        return {"model": "test", "source": "local"}
    async def no_search(*_args, **_kwargs):
        return {"search": False, "query": ""}
    async def model(_model, messages, _tools, on_chunk, _options):
        seen.append(messages)
        on_chunk("Hello")
        return {"content": "Hello", "toolCalls": [], "metrics": {}}

    monkeypatch.setattr(pipeline, "get_cloud_settings", settings)
    monkeypatch.setattr(pipeline, "get_resolved_model", resolved)
    monkeypatch.setattr(pipeline, "decide_search", no_search)
    monkeypatch.setattr(pipeline, "stream_chat_with_tools", model)

    async def run():
        scope = memory.plugin_memory_id("scope-owner", "plugin:sample:mode", "first")
        await memory.update_memory("scope-owner", {"enabled": True, "categories": {"Private": {"value": "global-only"}}})
        await memory.update_memory(scope, {"enabled": True, "categories": {"Context": {"value": "item-only"}}})
        options = {"model": "test", "mode": "chat", "userId": "scope-owner", "thinkingMode": "off",
                   "messages": [{"role": "user", "content": "Hello"}], "onChunk": lambda _chunk: None}
        await pipeline.run_pipeline({**options, "memoryUserId": scope})
        assert "item-only" in str(seen[-1]) and "global-only" not in str(seen[-1])
        await pipeline.run_pipeline({**options, "memoryUserId": None})
        assert "item-only" not in str(seen[-1]) and "global-only" not in str(seen[-1])

    asyncio.run(run())
