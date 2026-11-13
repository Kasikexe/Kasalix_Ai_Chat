import asyncio
import subprocess

from app.agent import execute_tool


def git(root, *args):
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout.strip()


def test_commit_selected_files_preserves_other_staged_changes(tmp_path):
    git(tmp_path, "init")
    git(tmp_path, "config", "user.name", "Test")
    git(tmp_path, "config", "user.email", "test@example.com")
    (tmp_path / "a.txt").write_text("before")
    (tmp_path / "b.txt").write_text("before")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "initial")
    (tmp_path / "a.txt").write_text("agent")
    (tmp_path / "b.txt").write_text("user")
    git(tmp_path, "add", "b.txt")
    result = asyncio.run(execute_tool(str(tmp_path), {"tool": "git_commit", "args": {"summary": "change a", "paths": ["a.txt"]}}, True))
    assert result["ok"], result
    assert git(tmp_path, "show", "--format=", "--name-only", "HEAD") == "a.txt"
    assert git(tmp_path, "diff", "--cached", "--name-only") == "b.txt"


def test_commit_requires_explicit_paths():
    result = asyncio.run(execute_tool(".", {"tool": "git_commit", "args": {"summary": "change"}}, True))
    assert not result["ok"]
    assert "paths" in result["output"]


def test_commit_refuses_selected_staged_changes(tmp_path):
    git(tmp_path, "init")
    git(tmp_path, "config", "user.name", "Test")
    git(tmp_path, "config", "user.email", "test@example.com")
    (tmp_path / "a.txt").write_text("initial")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "initial")
    (tmp_path / "a.txt").write_text("user")
    git(tmp_path, "add", "a.txt")
    result = asyncio.run(execute_tool(str(tmp_path), {"tool": "git_commit", "args": {"summary": "change", "paths": ["a.txt"]}}, True))
    assert not result["ok"]
    assert git(tmp_path, "diff", "--cached", "--name-only") == "a.txt"
