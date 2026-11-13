import asyncio

from app.agent import execute_tool
from app.routes import conversations


class Request:
    def __init__(self, path):
        self.path = str(path)

    async def json(self):
        return {"filePath": self.path}


def test_revert_preserves_later_user_edits(tmp_path, monkeypatch):
    path = tmp_path / "app.txt"
    path.write_text("agent", encoding="utf-8")
    entry = {"filePath": str(path), "originalContent": "before", "expectedContent": "agent", "originalAvailable": True, "snapshotAvailable": True}
    conv = {"workspacePath": str(tmp_path), "fileChanges": [entry]}

    async def get(*args):
        return conv

    async def update(_id, _owner, values):
        conv.update(values)

    monkeypatch.setattr(conversations, "user_id_from_request", lambda _: "owner")
    monkeypatch.setattr(conversations, "get_conversation", get)
    monkeypatch.setattr(conversations, "update_conversation", update)
    path.write_text("user changed this", encoding="utf-8")
    result = asyncio.run(conversations.revert_file("conv", Request(path)))
    assert result.status_code == 409
    assert path.read_text(encoding="utf-8") == "user changed this"
    path.write_text("agent", encoding="utf-8")
    assert asyncio.run(conversations.revert_file("conv", Request(path))) == {"success": True}
    assert path.read_text(encoding="utf-8") == "before"
    assert conv["fileChanges"] == []


def test_rename_records_both_paths_and_refuses_overwrite(tmp_path):
    source = tmp_path / "old.txt"
    target = tmp_path / "new.txt"
    source.write_text("original", encoding="utf-8")
    target.write_text("keep", encoding="utf-8")
    call = {"tool": "rename_file", "args": {"from": "old.txt", "to": "new.txt"}}
    assert not asyncio.run(execute_tool(str(tmp_path), call, True))["ok"]
    assert target.read_text(encoding="utf-8") == "keep"
    target.unlink()
    result = asyncio.run(execute_tool(str(tmp_path), call, True))
    assert result["ok"]
    assert [item["changeType"] for item in result["fileWrites"]] == ["deleted", "created"]
    assert result["fileWrites"][0]["originalContent"] == "original"


def test_smart_edit_reports_actual_file_path(tmp_path):
    folder = tmp_path / "src"
    folder.mkdir()
    path = folder / "app.py"
    path.write_text("before", encoding="utf-8")
    call = {"tool": "edit_file", "args": {"path": "app.py", "old_string": "before", "new_string": "after"}}
    result = asyncio.run(execute_tool(str(tmp_path), call, True))
    assert result["ok"]
    assert result["fileWrite"]["path"] == str(path)
