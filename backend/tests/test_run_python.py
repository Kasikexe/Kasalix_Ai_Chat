"""run_python tool tests.

The agent can now RUN a Python script headlessly to verify a fix instead of
guessing — the user's complaint was that it re-fixed a working snake game
three times because it could never confirm the fix. These tests pin the
contract: success is reported as success, a traceback is a FAILURE with the
exit code, an endless game loop is a timeout (not a hang), and the tool can
never run a path outside the workspace.
"""

from __future__ import annotations

import asyncio
import os

from app.agent import execute_tool, find_python_interpreter


def _run(root, call):
    return asyncio.run(execute_tool(str(root), call, True))


def test_runs_file_and_reports_success(tmp_path):
    (tmp_path / "hello.py").write_text("print('hello from snake')\n", encoding="utf-8")
    result = _run(tmp_path, {"tool": "run_python", "args": {"path": "hello.py"}})
    assert result["ok"] is True
    assert "exited 0" in result["output"]
    assert "hello from snake" in result["output"]


def test_traceback_is_reported_as_failure(tmp_path):
    (tmp_path / "broken.py").write_text("raise ValueError('boom')\n", encoding="utf-8")
    result = _run(tmp_path, {"tool": "run_python", "args": {"path": "broken.py"}})
    assert result["ok"] is False
    assert "FAILED with exit code" in result["output"]
    assert "ValueError" in result["output"]


def test_inline_snippet_runs_and_is_cleaned_up(tmp_path):
    result = _run(tmp_path, {"tool": "run_python", "args": {"code": "print(2 + 3)"}})
    assert result["ok"] is True
    assert "5" in result["output"]
    leftovers = [n for n in os.listdir(tmp_path) if n.startswith(".kx_run_")]
    assert not leftovers, f"staged snippet not cleaned up: {leftovers}"


def test_endless_loop_times_out_instead_of_hanging(tmp_path):
    (tmp_path / "loop.py").write_text("while True:\n    pass\n", encoding="utf-8")
    result = _run(tmp_path, {"tool": "run_python", "args": {"path": "loop.py", "timeout": 2}})
    # A timeout is NOT a crash — it means the program started and kept running.
    assert result["ok"] is True
    assert "STILL RUNNING" in result["output"]


def test_headless_env_is_injected_by_default(tmp_path):
    (tmp_path / "env.py").write_text(
        "import os\nprint(os.environ.get('SDL_VIDEODRIVER', 'MISSING'))\n",
        encoding="utf-8",
    )
    result = _run(tmp_path, {"tool": "run_python", "args": {"path": "env.py"}})
    assert result["ok"] is True
    assert "dummy" in result["output"], result["output"]


def test_headless_false_leaves_driver_alone(tmp_path, monkeypatch):
    monkeypatch.delenv("SDL_VIDEODRIVER", raising=False)
    (tmp_path / "env.py").write_text(
        "import os\nprint(os.environ.get('SDL_VIDEODRIVER', 'MISSING'))\n",
        encoding="utf-8",
    )
    result = _run(
        tmp_path,
        {"tool": "run_python", "args": {"path": "env.py", "headless": False}},
    )
    assert "MISSING" in result["output"]


def test_rejects_path_outside_workspace(tmp_path):
    outside = tmp_path.parent / "escape.py"
    outside.write_text("print('escaped')\n", encoding="utf-8")
    result = _run(tmp_path, {"tool": "run_python", "args": {"path": "../escape.py"}})
    assert result["ok"] is False
    assert "escaped" not in result["output"]


def test_missing_script_is_refused(tmp_path):
    result = _run(tmp_path, {"tool": "run_python", "args": {"path": "nope.py"}})
    assert result["ok"] is False


def test_requires_path_or_code(tmp_path):
    result = _run(tmp_path, {"tool": "run_python", "args": {}})
    assert result["ok"] is False
    assert "path" in result["output"]


def test_workspace_venv_interpreter_is_preferred(tmp_path):
    """A project venv inside the workspace must win — that is where the
    project's own packages (pygame, etc.) live."""
    rel = (r"venv\Scripts\python.exe", ".venv/bin/python") if os.name == "nt" else (".venv/bin/python", "venv/bin/python")
    venv_py = tmp_path / rel[0].replace("\\", "/")
    venv_py.parent.mkdir(parents=True)
    venv_py.write_text("", encoding="utf-8")
    assert find_python_interpreter(str(tmp_path)) == [str(venv_py)]
