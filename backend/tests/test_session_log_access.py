import asyncio

from app.routes import session_logs as routes
from app.services import session_log as logs


def test_logs_are_owned_and_deletable(tmp_path, monkeypatch):
    monkeypatch.setattr(logs, "get_data_dir", lambda: str(tmp_path))
    monkeypatch.setattr(routes, "get_data_dir", lambda: str(tmp_path))
    monkeypatch.setattr(routes, "session_authenticated", lambda request: request is not None)
    monkeypatch.setattr(routes, "user_id_from_request", lambda request: request)
    first = logs.SessionLog(owner_id="alice", conversation_id="conv-a")
    second = logs.SessionLog(owner_id="bob", conversation_id="conv-b")
    asyncio.run(first.init())
    asyncio.run(second.init())
    assert [item["runId"] for item in asyncio.run(logs.list_session_logs("alice"))] == [first.run_id]
    assert asyncio.run(routes.read_log(second.run_id, "alice")).status_code == 404
    assert asyncio.run(routes.delete_log(second.run_id, "alice")).status_code == 404
    assert asyncio.run(routes.read_log(first.run_id, None)).status_code == 401
    assert asyncio.run(routes.delete_log(first.run_id, "alice")) == {"success": True}
    assert asyncio.run(logs.read_session_log(first.run_id)) == []
    assert asyncio.run(logs.read_session_log(second.run_id))


def test_legacy_and_invalid_logs_are_not_exposed(tmp_path, monkeypatch):
    monkeypatch.setattr(logs, "get_data_dir", lambda: str(tmp_path))
    legacy = logs.SessionLog()
    asyncio.run(legacy.init())
    assert asyncio.run(logs.list_session_logs("alice")) == []
    assert asyncio.run(logs.read_session_log("../other")) == []
