"""Direct Python execution is unavailable; automatic checks still find Python."""

from __future__ import annotations

import asyncio
import os

from app.agent import execute_tool, find_python_interpreter


def _run(root, call):
    return asyncio.run(execute_tool(str(root), call, True))


def test_python_tool_does_not_execute_code(tmp_path):
    target = tmp_path / "side-effect.txt"
    code = f"from pathlib import Path; Path({str(target)!r}).write_text('executed')"
    result = _run(tmp_path, {"tool": "run_python", "args": {"code": code}})
    assert not result["ok"]
    assert not target.exists()














def test_rejects_path_outside_workspace(tmp_path):
    outside = tmp_path.parent / "escape.py"
    outside.write_text("print('escaped')\n", encoding="utf-8")
    result = _run(tmp_path, {"tool": "run_python", "args": {"path": "../escape.py"}})
    assert result["ok"] is False
    assert "escaped" not in result["output"]


def test_missing_script_is_refused(tmp_path):
    result = _run(tmp_path, {"tool": "run_python", "args": {"path": "nope.py"}})
    assert result["ok"] is False




def test_workspace_venv_interpreter_is_preferred(tmp_path):
    """A project venv inside the workspace must win — that is where the
    project's own packages (pygame, etc.) live."""
    rel = (r"venv\Scripts\python.exe", ".venv/bin/python") if os.name == "nt" else (".venv/bin/python", "venv/bin/python")
    venv_py = tmp_path / rel[0].replace("\\", "/")
    venv_py.parent.mkdir(parents=True)
    venv_py.write_text("", encoding="utf-8")
    assert find_python_interpreter(str(tmp_path)) == [str(venv_py)]
