import asyncio

from app.agent import execute_tool, list_workspace_tree
from app.utils import _INSTALL_ROOT, is_protected_path


def test_normal_backend_directory_is_available(tmp_path):
    backend = tmp_path / "backend"
    backend.mkdir()
    (backend / "main.py").write_text("print('hello')")
    assert not is_protected_path(str(tmp_path), str(backend / "main.py"))
    assert "backend/main.py" in asyncio.run(list_workspace_tree(str(tmp_path)))
    result = asyncio.run(execute_tool(str(tmp_path), {"tool": "read_file", "args": {"path": "backend/main.py"}}, True))
    assert result["ok"]


def test_real_install_and_node_modules_remain_protected(tmp_path):
    assert is_protected_path(str(_INSTALL_ROOT), str(_INSTALL_ROOT / "backend" / "app" / "agent.py"))
    assert is_protected_path(str(tmp_path), str(tmp_path / "node_modules" / "secret"))
