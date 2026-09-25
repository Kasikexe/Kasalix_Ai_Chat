"""End-to-end workflow tests — the paths a real user takes through the app.

Each test drives the REAL FastAPI app (isolated temp data dir) and/or the REAL
agent loop with a scripted fake model, so regressions in wiring (routes →
pipeline → agent → tools → storage) get caught before shipping. No Ollama
needed: the model layer is replaced, everything else is production code.

Covers the bugs actually shipped in v0.11.0:
- settings save → live reload without restart (stale cache)
- agent loop must NOT end after one tool call (loop-body break regression)
- churn breaker / identical-call guard / give-up message quality
- cloud probe: dead key fails cloud-only cleanly; auto falls back with an
  honest "local" source flag
- conversation lifecycle: create → chat → resume → update → delete
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from typing import Any

import pytest
from fastapi.testclient import TestClient

# Point the app at a temp data dir BEFORE importing the app module (same
# pattern as test_api.py — must not touch real user data).
_TMP = tempfile.mkdtemp(prefix="kasalix-workflow-")
os.environ.setdefault("DATA_DIR", _TMP)
os.environ.setdefault("OLLAMA_URL", "http://127.0.0.1:9")

from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def auth(client):
    """Register + login a test user; returns (token, user_id)."""
    r = client.post("/api/auth/register", json={"username": "workflow", "password": "secret123"})
    assert r.status_code in (200, 201), r.text
    data = r.json()
    return data["token"], data["user"]["id"]

# ─────────────────────────────────────────────────────────────
# 1. Settings workflow: save → immediately visible (no restart)
# ─────────────────────────────────────────────────────────────


class TestSettingsLiveReload:
    """PUT /api/settings must invalidate the cache so the next read sees it."""

    def test_save_then_assignment_read_sees_new_value(self, client, auth):
        token, _ = auth
        # Save a new chat assignment as the Server GUI does
        r = client.put(
            "/api/settings",
            json={"modelAssignments": {"chat": "test-model-live"}},
            headers={"Cookie": "settings_auth=1"},
        )
        assert r.status_code == 200, r.text
        # read_settings_cached() is what get_model_assignment uses — it must
        # see the new value on the FIRST read after save (cache invalidated).
        from app.model_assignments import get_model_assignment

        got = asyncio.run(get_model_assignment("chat"))
        assert got == "test-model-live", f"stale assignment after save: {got!r}"

    def test_save_then_cloud_settings_see_new_value(self, client, auth):
        r = client.put(
            "/api/settings",
            json={"cloudMode": "cloud", "cloudApiKey": "wk-live-check"},
            headers={"Cookie": "settings_auth=1"},
        )
        assert r.status_code == 200
        from app.settings_store import get_cloud_settings

        got = asyncio.run(get_cloud_settings())
        assert got["cloudMode"] == "cloud"
        assert got["cloudApiKey"] == "wk-live-check"

    def test_reset_clears_assignments_immediately(self, client, auth):
        r = client.put(
            "/api/settings",
            json={"modelAssignments": {"chat": "to-be-reset"}},
            headers={"Cookie": "settings_auth=1"},
        )
        assert r.status_code == 200
        r = client.post("/api/settings/reset", headers={"Cookie": "settings_auth=1"})
        assert r.status_code == 200
        from app.model_assignments import get_model_assignment

        got = asyncio.run(get_model_assignment("chat"))
        # After reset the explicit assignment is gone → env/default applies
        assert got != "to-be-reset"

    def test_get_settings_reflects_saved_assignments(self, client, auth):
        r = client.put(
            "/api/settings",
            json={"modelAssignments": {"code": "coder-x"}},
            headers={"Cookie": "settings_auth=1"},
        )
        assert r.status_code == 200
        got = client.get("/api/settings").json()
        assert got.get("modelAssignments", {}).get("code") == "coder-x"


# ─────────────────────────────────────────────────────────────
# 1b. Ollama concurrency settings: save → env vars on restart
# ─────────────────────────────────────────────────────────────


class TestOllamaConcurrencySettings:
    """The three Ollama tuning knobs must survive save → read → env build."""

    def test_build_ollama_env_auto_sets_nothing(self):
        from app.routes.ollama import _build_ollama_env

        env = _build_ollama_env(True, "f32", num_parallel=0, max_loaded_models=0, keep_alive="")
        assert env == {}, f"Auto must not inject env vars, got {env}"

    def test_build_ollama_env_sets_all_three(self):
        from app.routes.ollama import _build_ollama_env

        env = _build_ollama_env(True, "q8_0", num_parallel=2, max_loaded_models=3, keep_alive="1h")
        assert env == {
            "LLAMA_ARG_CACHE_TYPE_K": "q8_0",
            "LLAMA_ARG_CACHE_TYPE_V": "q8_0",
            # quantized KV cache requires flash attention — without it the
            # cache type is silently ignored by llama.cpp
            "OLLAMA_FLASH_ATTENTION": "1",
            "OLLAMA_NUM_PARALLEL": "2",
            "OLLAMA_MAX_LOADED_MODELS": "3",
            "OLLAMA_KEEP_ALIVE": "1h",
        }

    def test_build_ollama_env_f16_does_not_force_flash_attention(self):
        from app.routes.ollama import _build_ollama_env

        env = _build_ollama_env(True, "f16", num_parallel=2)
        assert "OLLAMA_FLASH_ATTENTION" not in env
        assert env["OLLAMA_NUM_PARALLEL"] == "2"

    def test_build_ollama_env_invalid_values_dropped(self):
        from app.routes.ollama import _build_ollama_env

        env = _build_ollama_env(True, "f32", num_parallel=-5, max_loaded_models="bogus", keep_alive="junk!")
        assert env == {}, f"invalid values must be dropped, got {env}"

        # keep_alive accepts bare seconds and -1 (never unload)
        env2 = _build_ollama_env(True, "f32", keep_alive="3600")
        assert env2 == {"OLLAMA_KEEP_ALIVE": "3600"}
        env3 = _build_ollama_env(True, "f32", keep_alive="-1")
        assert env3 == {"OLLAMA_KEEP_ALIVE": "-1"}

    def test_build_ollama_env_clamps_parallel(self):
        from app.routes.ollama import _build_ollama_env

        env = _build_ollama_env(True, "f32", num_parallel=99)
        assert env == {"OLLAMA_NUM_PARALLEL": "16"}

    def test_build_ollama_env_combines_with_kv_flags(self):
        from app.routes.ollama import _build_ollama_env

        env = _build_ollama_env(False, "q4_0", num_parallel=4)
        assert env["LLAMA_ARG_KV_OFFLOAD"] == "0"
        assert env["OLLAMA_NUM_PARALLEL"] == "4"

    def test_save_ollama_tuning_roundtrip(self, client, auth):
        r = client.put(
            "/api/settings",
            json={"ollamaNumParallel": 2, "ollamaMaxLoadedModels": 2, "ollamaKeepAlive": "30m"},
            headers={"Cookie": "settings_auth=1"},
        )
        assert r.status_code == 200, r.text
        from app.settings_store import get_ollama_settings

        got = asyncio.run(get_ollama_settings())
        assert got["ollamaNumParallel"] == 2
        assert got["ollamaMaxLoadedModels"] == 2
        assert got["ollamaKeepAlive"] == "30m"

    def test_ollama_tuning_coerced_on_read(self, client, auth):
        # Junk / out-of-range values saved via PUT must normalize on read.
        r = client.put(
            "/api/settings",
            json={"ollamaNumParallel": "abc", "ollamaMaxLoadedModels": 99, "ollamaKeepAlive": "not-a-time"},
            headers={"Cookie": "settings_auth=1"},
        )
        assert r.status_code == 200
        from app.settings_store import get_ollama_settings

        got = asyncio.run(get_ollama_settings())
        assert got["ollamaNumParallel"] == 0
        assert got["ollamaMaxLoadedModels"] == 16
        assert got["ollamaKeepAlive"] == ""

    def test_restart_route_reads_tuning_from_settings(self, client, auth):
        r = client.put(
            "/api/settings",
            json={"ollamaNumParallel": 2, "ollamaMaxLoadedModels": 0, "ollamaKeepAlive": ""},
            headers={"Cookie": "settings_auth=1"},
        )
        assert r.status_code == 200

        from unittest.mock import patch

        import app.routes.ollama as om

        with patch.object(om, "_build_ollama_env", wraps=om._build_ollama_env) as spy, \
             patch.object(om, "is_ollama_running", return_value=False), \
             patch.object(om, "_spawn_ollama", return_value=None), \
             patch.object(om, "_wait_for_ollama_up", return_value=True):
            res = client.post("/api/ollama/restart", json={"confirm": True}, headers={"Cookie": "settings_auth=1"})
        assert res.status_code == 200, res.text
        assert res.json().get("success") is True
        kwargs = spy.call_args.kwargs
        assert kwargs.get("num_parallel") == 2
        assert kwargs.get("max_loaded_models") == 0
        assert kwargs.get("keep_alive") == ""


# ─────────────────────────────────────────────────────────────
# 2. Agent loop workflow (real loop, fake model)
# ─────────────────────────────────────────────────────────────


def _make_fake_model(responses: list[str], calls: list[int] | None = None):
    """Patch app.agent.stream_chat_with_retry with a scripted model."""
    import app.agent as agent

    counter = {"n": 0}

    async def fake_stream(opts, messages, on_chunk, on_thinking_chunk, **kw):
        counter["n"] += 1
        if calls is not None:
            calls.append(counter["n"])
        if counter["n"] <= len(responses):
            resp = responses[counter["n"] - 1]
        else:
            resp = "Task complete."
        on_chunk(resp)
        return resp

    original = agent.stream_chat_with_retry
    agent.stream_chat_with_retry = fake_stream
    return original, counter


def _run_loop(workspace: str, responses: list[str]) -> tuple[str, int]:
    import app.agent as agent

    calls: list[int] = []
    original, counter = _make_fake_model(responses, calls)
    try:
        result = asyncio.run(
            agent.run_agent_loop(
                {
                    "model": "fake-model",
                    "workspacePath": workspace,
                    "autoApply": True,
                    "messages": [{"role": "user", "content": "do the task"}],
                    "callbacks": {"onChunk": lambda *_: None},
                }
            )
        )
        return result, counter["n"]
    finally:
        agent.stream_chat_with_retry = original


class TestAgentLoopWorkflow:
    """The multi-round loop: tools chain, run finishes, no false max-steps."""

    def test_multi_round_tool_chain_completes(self, tmp_path):
        (tmp_path / "notes.txt").write_text("hello notes", encoding="utf-8")
        responses = [
            '{"tool": "read_file", "args": {"path": "notes.txt"}}',
            '{"tool": "write_file", "args": {"path": "out.txt", "content": "result"}}',
            '{"tool": "run_command", "args": {"command": "echo workflow-ok"}}',
            "All steps finished successfully.",
        ]
        result, rounds = _run_loop(str(tmp_path), responses)
        assert rounds >= 4, f"loop ended early after {rounds} round(s)"
        assert "maximum number of steps" not in result
        assert (tmp_path / "out.txt").read_text(encoding="utf-8") == "result"

    def test_reasoning_only_empty_reply_is_nudged_not_dead_ended(self, tmp_path):
        # The snake regression: the model put its whole answer in the THINKING
        # channel and returned an EMPTY content string with no tool call. The
        # loop fell straight through to the final-answer path and printed "my
        # response came back as an incomplete tool call and no work had been
        # done yet" on the very FIRST round — without ever asking the model to
        # answer. An empty reply must be nudged, not dead-ended.
        responses = [
            "",
            '{"tool": "write_file", "args": {"path": "snake.py", "content": "print(1)\\n"}}',
            "Done — created snake.py.",
        ]
        result, rounds = _run_loop(str(tmp_path), responses)
        assert "incomplete tool call" not in result, f"dead-end fallback shipped: {result[:200]}"
        assert "could not produce a final answer" not in result
        assert rounds >= 2, "empty reply did not trigger a retry round"
        assert (tmp_path / "snake.py").read_text(encoding="utf-8") == "print(1)\n"

    def test_bracket_style_tool_call_is_executed_not_talked_about(self, tmp_path):
        """The user's report: the model emitted [write_file, {...}] — not JSON —
        so NOTHING ran, yet the narration shipped as the answer. It must execute."""
        responses = [
            '[write_file, {"path": "snake_game.py", "content": "print(1)\\n"}]',
            "Created the game.",
        ]
        result, _ = _run_loop(str(tmp_path), responses)
        assert (tmp_path / "snake_game.py").exists(), "bracket-style call never executed"
        assert (tmp_path / "snake_game.py").read_text(encoding="utf-8") == "print(1)\n"
        assert "[write_file" not in result, f"raw bracket syntax leaked to the user: {result[:200]}"

    def test_paren_style_tool_call_is_executed(self, tmp_path):
        responses = [
            'write_file({"path": "out.txt", "content": "hi"})',
            "Wrote out.txt.",
        ]
        _run_loop(str(tmp_path), responses)
        assert (tmp_path / "out.txt").read_text(encoding="utf-8") == "hi"

    def test_promising_to_read_without_a_tool_call_is_nudged(self, tmp_path):
        """"Let me read the file to check what is wrong" with NO tool call must
        be nudged — otherwise the user is told it is investigating when nothing ran."""
        (tmp_path / "game.py").write_text("x = 1\n", encoding="utf-8")
        responses = [
            "Let me read game.py to check what is wrong and then fix it.",
            '{"tool": "read_file", "args": {"path": "game.py"}}',
            "I read the file — x is 1.",
        ]
        result, rounds = _run_loop(str(tmp_path), responses)
        assert rounds >= 3, f"promise-without-action was not nudged (rounds={rounds})"
        assert "I read the file" in result, f"run ended on the promise instead of acting: {result[:200]!r}"

    def test_loop_survives_failing_tool_then_succeeds(self, tmp_path):
        # Edit fails (old_string not present) → model reads file → fixes → done
        (tmp_path / "app.py").write_text("value = 1\n", encoding="utf-8")
        responses = [
            '{"tool": "edit_file", "args": {"path": "app.py", "old_string": "NOT IN FILE", "new_string": "x"}}',
            '{"tool": "read_file", "args": {"path": "app.py"}}',
            '{"tool": "edit_file", "args": {"path": "app.py", "old_string": "value = 1", "new_string": "value = 2"}}',
            "Fixed the value.",
        ]
        result, rounds = _run_loop(str(tmp_path), responses)
        assert rounds >= 4, f"failure recovery loop ended early: {rounds}"
        assert "maximum number of steps" not in result
        assert "value = 2" in (tmp_path / "app.py").read_text(encoding="utf-8")

    def test_stalled_run_gives_up_honestly(self, tmp_path):
        # Model repeats the SAME failing edit 3× → identical-call guard fires
        # with an actionable message (no raw JSON dump).
        bad = '{"tool": "edit_file", "args": {"path": "f.py", "old_string": "zzz", "new_string": "yyy"}}'
        (tmp_path / "f.py").write_text("real content\n", encoding="utf-8")
        result, _ = _run_loop(str(tmp_path), [bad] * 6)
        assert "kept failing" in result
        assert "zzz" not in result, "give-up message leaked raw tool JSON"
        assert '"tool"' not in result, "give-up message dumped the tool call"

    def test_successful_repeats_never_say_kept_failing(self, tmp_path):
        # The tetris regression: three IDENTICAL SUCCESSFUL reads tripped the
        # guard with "my read_file attempt kept failing the same way" — a
        # lie. A successful-repeat loop must be reported honestly as looping.
        (tmp_path / "app.py").write_text("print(1)\n", encoding="utf-8")
        read = '{"tool": "read_file", "args": {"path": "app.py"}}'
        result, _ = _run_loop(str(tmp_path), [read] * 4)
        assert "looping" in result, f"honest loop message missing: {result[:200]}"
        assert "kept failing" not in result, "guard lied about successful reads"
        assert "failed" not in result.lower(), "guard still framed a success-loop as failure"

    def test_churn_breaker_stops_consecutive_failures(self, tmp_path):
        # FOUR different failing calls in a row → fail-streak breaker.
        # (Threshold raised from 3: three failures can be legitimate
        # debugging; the breaker must only stop runs that don't converge.)
        responses = [
            '{"tool": "edit_file", "args": {"path": "f.py", "old_string": "a1", "new_string": "b1"}}',
            '{"tool": "edit_file", "args": {"path": "f.py", "old_string": "a2", "new_string": "b2"}}',
            '{"tool": "edit_file", "args": {"path": "f.py", "old_string": "a3", "new_string": "b3"}}',
            '{"tool": "edit_file", "args": {"path": "f.py", "old_string": "a4", "new_string": "b4"}}',
            '{"tool": "read_file", "args": {"path": "f.py"}}',
        ]
        (tmp_path / "f.py").write_text("content\n", encoding="utf-8")
        result, _ = _run_loop(str(tmp_path), responses)
        assert "I got stuck" in result

    def test_read_only_failures_do_not_trip_churn_breaker(self, tmp_path):
        # The regression behind "read_file kept failing the same way": varying
        # read attempts (different offsets, like the transcript) are
        # legitimate work — they must reset (not count toward) the
        # consecutive-failure breaker. (Repeating the EXACT same call 3× is a
        # loop and still stops via the identical-call guard — by design.)
        body = "\n".join(f"line{i}" for i in range(30)) + "\n"
        (tmp_path / "app.py").write_text(body, encoding="utf-8")
        responses = [
            '{"tool": "read_file", "args": {"path": "missing.txt"}}',
            '{"tool": "read_file", "args": {"path": "app.py", "offset": 0}}',
            '{"tool": "read_file", "args": {"path": "app.py", "offset": 10}}',
            '{"tool": "search_files", "args": {"query": "tetris"}}',
            '{"tool": "read_file", "args": {"path": "app.py", "offset": 20}}',
            '{"tool": "read_file", "args": {"path": "missing.txt"}}',
            "Nothing there — moving on.",
        ]
        result, rounds = _run_loop(str(tmp_path), responses)
        assert "I got stuck" not in result
        assert "kept failing" not in result
        assert rounds >= 7, f"read failures burned the loop early: {rounds}"

    def test_truncated_write_call_is_refused_not_executed(self, tmp_path):
        # Generation cut off mid-JSON → the salvaged half-call must NOT be
        # executed (that is how a 32-line truncated tetris.py got created),
        # and the model must be told to write in smaller pieces.
        truncated = '{"tool": "write_file", "args": {"path": "game.py", "content": "import pygame\\npygame.init()'
        responses = [
            truncated,
            '{"tool": "write_file", "args": {"path": "game.py", "content": "COMPLETE FILE\\n"}}',
            "Done — created the game.",
        ]
        result, _ = _run_loop(str(tmp_path), responses)
        # The truncated content must never reach disk
        on_disk = (tmp_path / "game.py").read_text(encoding="utf-8")
        assert "import pygame" not in on_disk
        assert on_disk == "COMPLETE FILE\n"
        # The retry round happened and the run completed normally
        assert "Done" in result

    def test_read_file_returns_whole_small_file_despite_tiny_length(self, tmp_path):
        # The 200-byte-slicing bug: a model requesting a tiny window on a
        # small file gets the WHOLE file, not a sliver with a "continue"
        # hint that sends it hunting for content that reads as a failure.
        body = "\n".join(f"line{i} = {i}" for i in range(50)) + "\n"
        (tmp_path / "app.py").write_text(body, encoding="utf-8")
        responses = [
            '{"tool": "read_file", "args": {"path": "app.py", "length": 200}}',
            f'{{"tool": "write_file", "args": {{"path": "out.txt", "content": "saw {body.count(chr(10))} lines"}}}}',
            "Read complete.",
        ]
        import app.agent as agent

        captured: list[str] = []
        original_execute = agent.execute_tool

        async def spy_execute(root, call, auto_apply, extra=None):
            r = await original_execute(root, call, auto_apply, extra)
            if call["tool"] == "read_file":
                captured.append(str(r["output"]))
            return r

        original, counter = _make_fake_model(responses)
        agent.execute_tool = spy_execute
        try:
            result, _ = _run_loop(str(tmp_path), responses)
        finally:
            agent.execute_tool = original_execute
            agent.stream_chat_with_retry = original
        assert captured, "read_file was never executed"
        assert "line49" in captured[0], "small file was sliced instead of returned whole"
        assert "continue" not in captured[0], "truncation suffix shown for a whole-file read"

    def test_delete_own_work_blocked_without_user_intent(self, tmp_path):
        # Model writes then tries to delete its own file → blocked
        responses = [
            '{"tool": "write_file", "args": {"path": "game.py", "content": "print(1)"}}',
            '{"tool": "delete_file", "args": {"path": "game.py"}}',
            "Writing the file now.",
        ]
        _run_loop(str(tmp_path), responses)
        assert (tmp_path / "game.py").exists(), "agent deleted its own work"

    def test_final_answer_without_tools(self, tmp_path):
        result, rounds = _run_loop(str(tmp_path), ["The answer is 42."])
        assert rounds == 1
        assert result == "The answer is 42."

    def test_write_refusal_recovers_via_edit_file(self, tmp_path):
        # The write_file rewrite guard refuses a full rewrite twice; the
        # auto-recovery must inject the current content and the model must
        # then succeed with a targeted edit_file (NOT keep re-rolling
        # write_file until the churn breaker fires).
        # >50-line file so a full rewrite actually trips the rewrite guard
        body = "\n".join(f"line{i} = {i}" for i in range(80)) + "\n"
        (tmp_path / "game.py").write_text(body, encoding="utf-8")
        full_rewrite = "# my new program\n" + "\n".join(f"step{i}" for i in range(80)) + "\n"
        responses = [
            # Twice: model tries a full rewrite → refused by the rewrite guard
            '{"tool": "write_file", "args": {"path": "game.py", "content": ' + json.dumps(full_rewrite) + '}}',
            '{"tool": "write_file", "args": {"path": "game.py", "content": ' + json.dumps(full_rewrite) + '}}',
            # After auto-recovery injected the real content: targeted edit
            '{"tool": "edit_file", "args": {"path": "game.py", "old_string": "line0 = 0", "new_string": "line0 = 42"}}',
            "Done — updated the file.",
        ]
        result, rounds = _run_loop(str(tmp_path), responses)
        assert rounds >= 4, f"recovery loop ended early: {rounds}"
        content = (tmp_path / "game.py").read_text(encoding="utf-8")
        assert "line0 = 42" in content
        assert "line1 = 1" in content, "edit replaced the whole file instead of a targeted line"
        assert "step0" not in content, "refused write_file content must never land on disk"

    def test_workspace_tools_are_sandboxed(self, tmp_path):
        # write_file outside the workspace must be refused
        responses = [
            '{"tool": "write_file", "args": {"path": "../escape.txt", "content": "evil"}}',
            "Trying the write.",
        ]
        parent = tmp_path.parent
        _run_loop(str(tmp_path), responses)
        assert not (parent / "escape.txt").exists(), "sandbox escape via ../"

    def test_false_success_after_all_writes_failed_is_challenged(self, tmp_path):
        """Replays the user's live transcript: write_file refused as a full
        rewrite → read_file → multi_edit with a bad schema → the model claims
        'I have successfully added the menu system'. Nothing changed on disk,
        so the claim MUST be challenged, never emitted to the user."""
        # >50 lines so the rewrite guard refuses full rewrites
        body = "\n".join(f"line{i} = {i}" for i in range(80)) + "\n"
        (tmp_path / "main.py").write_text(body, encoding="utf-8")
        full_rewrite = "# menu version\n" + "\n".join(f"menu{i}" for i in range(80)) + "\n"
        responses = [
            '{"tool": "write_file", "args": {"path": "main.py", "content": ' + json.dumps(full_rewrite) + '}}',
            '{"tool": "read_file", "args": {"path": "main.py"}}',
            # The malformed multi_edit the model actually sent (no "edits" key)
            '{"tool": "multi_edit", "args": {"path": "main.py", "old_string": "line0 = 0", "new_string": "line0 = 9"}}',
            "I have successfully added the menu system to your game.",
            "You are right — my edits failed. The write_file was refused as a full rewrite and multi_edit needs an edits array, so nothing changed on disk.",
        ]
        result, rounds = _run_loop(str(tmp_path), responses)
        assert "successfully added" not in result, f"false success reached the user: {result!r}"
        assert "my edits failed" in result, f"honest failure never surfaced: {result!r}"
        content = (tmp_path / "main.py").read_text(encoding="utf-8")
        assert "menu0" not in content, "refused rewrite landed on disk"
        assert "line0 = 0" in content, "file was modified by the failed multi_edit"

    def test_root_file_with_asset_dirs_not_blocked(self, tmp_path):
        """The user's live failure: the agent created assets/ then tried to
        write index.html at the root. index.html + assets/ is the STANDARD
        single web project layout — the multi-project guard must NOT fire."""
        (tmp_path / "assets").mkdir()
        (tmp_path / "assets" / "logo.svg").write_text("<svg/>", encoding="utf-8")
        responses = [
            '{"tool": "write_file", "args": {"path": "index.html", "content": "<html><body>game</body></html>"}}',
            "Created the game page with its assets folder.",
        ]
        result, _ = _run_loop(str(tmp_path), responses)
        assert (tmp_path / "index.html").exists(), f"standard web layout blocked: {result!r}"
        assert "multi-project" not in result

    def test_multi_project_refusal_names_force_escape(self, tmp_path):
        """A genuinely ambiguous root write is refused, but the error must
        offer the force:true escape — and force:true must actually work."""
        (tmp_path / "projA").mkdir()
        (tmp_path / "projB").mkdir()
        wf = lambda path, force: json.dumps({
            "tool": "write_file",
            "args": {"path": path, "content": "x", **({"force": True} if force else {})},
        })
        responses = [
            wf("README.md", False),
            wf("README.md", True),
            "Created the readme at the root as intended.",
        ]
        result, rounds = _run_loop(str(tmp_path), responses)
        assert "multi-project" in result or (tmp_path / "README.md").exists(), f"no guidance given: {result!r}"
        assert (tmp_path / "README.md").exists(), "force:true did not bypass the guard"
        assert rounds >= 3, f"loop ended early: {rounds}"

    def test_multi_edit_changes_key_and_camelcase_accepted(self, tmp_path):
        # multi_edit dialect drift: "changes" instead of "edits", camelCase keys
        (tmp_path / "app.py").write_text("a = 1\nb = 2\n", encoding="utf-8")
        responses = [
            '{"tool": "multi_edit", "args": {"path": "app.py", "changes": [{"oldString": "a = 1", "newString": "a = 11"}, {"oldString": "b = 2", "newString": "b = 22"}]}}',
            "Both edits applied.",
        ]
        _run_loop(str(tmp_path), responses)
        content = (tmp_path / "app.py").read_text(encoding="utf-8")
        assert "a = 11" in content and "b = 22" in content

    def test_multi_edit_teaching_error_mentions_format(self, tmp_path):
        # A bare/wrong multi_edit must return the FORMAT in its error so the
        # model can self-correct next round instead of flailing.
        (tmp_path / "app.py").write_text("a = 1\n", encoding="utf-8")
        from app.agent import execute_tool

        result = asyncio.run(execute_tool(
            str(tmp_path),
            {"tool": "multi_edit", "args": {"path": "app.py"}},
            True,
        ))
        assert not result["ok"]
        assert '"edits"' in result["output"] and "old_string" in result["output"]

    def test_budget_fallout_admits_total_write_failure(self, tmp_path):
        """Every mutation failed this run → the final 'max steps' message must
        say nothing was changed, not imply progress."""
        body = "\n".join(f"line{i} = {i}" for i in range(80)) + "\n"
        (tmp_path / "main.py").write_text(body, encoding="utf-8")
        full_rewrite = "# nope\n" + "\n".join(f"x{i}" for i in range(80)) + "\n"
        # Repeat distinct-content refusals until the loop falls out at budget
        responses = [
            '{"tool": "write_file", "args": {"path": "main.py", "content": ' + json.dumps(full_rewrite) + '}}',
            "I finished the task successfully.",
            "Truly done.",
        ]
        result, _ = _run_loop(str(tmp_path), responses)
        assert ("Nothing was changed" in result) or ("my write/edit attempts kept failing" in result) or ("successfully" not in result), (
            f"false completion survived all guards: {result!r}"
        )
        assert "menu" not in (tmp_path / "main.py").read_text(encoding="utf-8") or "x0" not in (tmp_path / "main.py").read_text(encoding="utf-8")


# ─────────────────────────────────────────────────────────────
# 3. Cloud routing workflow (probe / fallback / source flag)
# ─────────────────────────────────────────────────────────────


class TestCloudRoutingWorkflow:
    """Cloud mode decisions: dead key → clean error in cloud-only, honest
    local fallback in auto."""

    def test_cloud_only_no_key_fails_cleanly(self, client, auth):
        token, _ = auth
        client.put(
            "/api/settings",
            json={"cloudMode": "cloud", "cloudApiKey": "", "cloudEndpoint": "https://ollama.com"},
            headers={"Cookie": "settings_auth=1"},
        )
        r = client.post(
            "/api/chat/",
            json={"model": "some-cloud-model", "messages": [{"role": "user", "content": "hi"}]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200  # SSE started
        body = r.text
        assert "no API key" in body or "error" in body.lower()

    def test_dead_key_cloud_only_errors_not_falls_back(self, client, auth):
        token, _ = auth
        # Settings point cloud at an unreachable endpoint with a key → probe
        # fails → cloud-only must surface an error, NOT silently use local.
        client.put(
            "/api/settings",
            json={"cloudMode": "cloud", "cloudApiKey": "wk-dead", "cloudEndpoint": "http://127.0.0.1:9"},
            headers={"Cookie": "settings_auth=1"},
        )
        r = client.post(
            "/api/chat/",
            json={"model": "cloud-only-model", "messages": [{"role": "user", "content": "hi"}]},
            headers={"Authorization": f"Bearer {token}"},
        )
        body = r.text
        assert "invalid" in body.lower() or "unreachable" in body.lower() or "error" in body.lower()

    def test_auto_mode_dead_cloud_falls_back_to_local(self, client, auth):
        token, _ = auth
        client.put(
            "/api/settings",
            json={
                "cloudMode": "auto",
                "cloudApiKey": "wk-dead",
                "cloudEndpoint": "http://127.0.0.1:9",
                "cloudModelAssignments": {"chat": "cloud-only-model"},
                "modelAssignments": {"chat": "local-fallback-model"},
            },
            headers={"Cookie": "settings_auth=1"},
        )
        r = client.post(
            "/api/chat/",
            json={"model": "cloud-only-model", "messages": [{"role": "user", "content": "hi"}]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
        # The stream must contain SOME reply (local fallback ran) — or a clean
        # connection error event, but never a silent hang/empty body.
        assert len(r.text) > 0

    def _cleanup_settings(self, client):
        client.put(
            "/api/settings",
            json={"cloudMode": "local", "cloudApiKey": "", "cloudEndpoint": "", "cloudModelAssignments": {}},
            headers={"Cookie": "settings_auth=1"},
        )

    def teardown_method(self, client=None):
        # Restore safe defaults so later tests aren't affected
        try:
            client.put(
                "/api/settings",
                json={"cloudMode": "local", "cloudApiKey": "", "cloudEndpoint": "", "cloudModelAssignments": {}},
                headers={"Cookie": "settings_auth=1"},
            )
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────
# 4. Conversation lifecycle workflow
# ─────────────────────────────────────────────────────────────


class TestConversationLifecycle:
    def test_full_lifecycle(self, client, auth):
        token, user_id = auth
        h = {"Authorization": f"Bearer {token}"}
        # Create
        r = client.post("/api/conversations", json={"model": "m1"}, headers=h)
        assert r.status_code == 200, r.text
        conv = r.json()["conversation"]
        cid = conv["id"]
        assert conv["mode"] == "chat"
        # List contains it
        lst = client.get("/api/conversations", headers=h).json()["conversations"]
        assert any(c["id"] == cid for c in lst)
        # Get
        got = client.get(f"/api/conversations/{cid}", headers=h)
        assert got.status_code == 200
        # Update title
        upd = client.put(f"/api/conversations/{cid}", json={"title": "Renamed"}, headers=h)
        assert upd.status_code == 200
        assert upd.json()["conversation"]["title"] == "Renamed"
        # Delete
        dele = client.delete(f"/api/conversations/{cid}", headers=h)
        assert dele.status_code == 200
        assert client.get(f"/api/conversations/{cid}", headers=h).status_code == 404

    def test_agent_conversation_has_workspace_fields(self, client, auth):
        token, _ = auth
        h = {"Authorization": f"Bearer {token}"}
        r = client.post(
            "/api/conversations",
            json={"model": "m1", "mode": "agent", "workspacePath": "C:/tmp"},
            headers=h,
        )
        conv = r.json()["conversation"]
        assert conv["mode"] == "agent"
        assert conv["agentState"] is None  # resume logic relies on this
        client.delete(f"/api/conversations/{conv['id']}", headers=h)

    def test_conversations_isolated_between_users(self, client, auth):
        token, _ = auth
        h = {"Authorization": f"Bearer {token}"}
        r = client.post("/api/conversations", json={"model": "m1"}, headers=h)
        cid = r.json()["conversation"]["id"]
        # Other user cannot see/update/delete it
        r2 = client.post("/api/auth/register", json={"username": "otheruser", "password": "secret123"})
        if r2.status_code in (200, 201):
            token2 = r2.json()["token"]
            h2 = {"Authorization": f"Bearer {token2}"}
            assert client.get(f"/api/conversations/{cid}", headers=h2).status_code == 404
            assert client.delete(f"/api/conversations/{cid}", headers=h2).status_code == 404
        client.delete(f"/api/conversations/{cid}", headers=h)

    def test_malformed_chat_bodies_rejected(self, client, auth):
        token, _ = auth
        h = {"Authorization": f"Bearer {token}"}
        for bad in [None, {"model": "m"}, {"messages": "notalist"}]:
            r = client.post("/api/chat/", json=bad, headers=h)
            assert r.status_code == 400, f"body {bad!r} → {r.status_code}"


# ─────────────────────────────────────────────────────────────
# 5. Preview workflow: agent sees its own web work
# ─────────────────────────────────────────────────────────────


class TestPreviewWorkflow:
    """preview_start through the REAL agent loop with a fake client bridge."""

    def test_preview_start_opens_window_via_bridge(self, tmp_path):
        import app.agent as agent
        import app.preview as pv
        from app.agent import run_agent_loop

        (tmp_path / "index.html").write_text("<html><body>game</body></html>", encoding="utf-8")
        opened: list[str] = []
        scripted = [
            json.dumps({"tool": "preview_start", "args": {"entry": "index.html"}}),
            "The preview is live and the game renders. Task complete.",
        ]
        original_stream = agent.stream_chat_with_retry
        original_call = pv.client_call
        counter = {"n": 0}

        async def fake_stream(opts, messages, on_chunk, on_thinking_chunk, **kw):
            counter["n"] += 1
            resp = scripted[counter["n"] - 1] if counter["n"] <= len(scripted) else "Done."
            on_chunk(resp)
            return resp

        async def fake_client_call(payload: dict, timeout: float = 12.0) -> dict:
            if payload.get("type") == "open":
                opened.append(payload.get("url") or "")
                # Simulate the preview page registering itself
                pv.get_preview_session().window_registered.set()
                return {"ok": True}
            return {"ok": True}

        agent.stream_chat_with_retry = fake_stream
        pv.client_call = fake_client_call
        try:
            result = asyncio.run(
                run_agent_loop(
                    {
                        "model": "fake-model",
                        "workspacePath": str(tmp_path),
                        "autoApply": True,
                        "messages": [{"role": "user", "content": "make a web game"}],
                        "callbacks": {"onChunk": lambda *_: None},
                    }
                )
            )
        finally:
            agent.stream_chat_with_retry = original_stream
            pv.client_call = original_call
            pv.stop_preview()
        # The scripted model called preview_start; the bridge received the open
        # request and the loop returned without error.
        assert result, result
        assert opened, "preview_start never reached the client bridge"
        assert "__kxid=" in opened[0], opened[0]
        assert "index.html" in opened[0], opened[0]
        assert pv.get_preview_session() is None, "preview must be cleaned up after the run"

    def test_preview_hidden_mode_reports_headless(self, tmp_path):
        """When the user hides the preview window, the open call returns
        hidden=True and the agent is told verification runs headless."""
        import app.agent as agent
        import app.preview as pv
        from app.agent import run_agent_loop

        (tmp_path / "index.html").write_text("<html><body>game</body></html>", encoding="utf-8")
        scripted = [
            json.dumps({"tool": "preview_start", "args": {"entry": "index.html"}}),
            "Verified headless — the user can open the URL in a browser. Done.",
        ]
        captured = {"result": ""}

        async def fake_client_call(payload: dict, timeout: float = 12.0) -> dict:
            if payload.get("type") == "open":
                pv.get_preview_session().window_registered.set()
                return {"ok": True, "hidden": True}
            return {"ok": True}

        original_stream = agent.stream_chat_with_retry
        original_call = pv.client_call
        counter = {"n": 0}

        async def fake_stream(opts, messages, on_chunk, on_thinking_chunk, **kw):
            counter["n"] += 1
            resp = scripted[counter["n"] - 1] if counter["n"] <= len(scripted) else "Done."
            on_chunk(resp)
            return resp

        agent.stream_chat_with_retry = fake_stream
        pv.client_call = fake_client_call

        def on_tool_result(r: dict) -> None:
            if r.get("tool") == "preview_start":
                captured["result"] = str(r.get("output") or "")

        try:
            asyncio.run(
                run_agent_loop(
                    {
                        "model": "fake-model",
                        "workspacePath": str(tmp_path),
                        "autoApply": True,
                        "messages": [{"role": "user", "content": "make a web game"}],
                        "callbacks": {"onChunk": lambda *_: None, "onToolResult": on_tool_result},
                    }
                )
            )
        finally:
            agent.stream_chat_with_retry = original_stream
            pv.client_call = original_call
            pv.stop_preview()
        assert "headless" in captured["result"], captured["result"]
        assert "user can open" in captured["result"], captured["result"]

    def test_write_noop_then_repeat_does_not_trip_guard(self, tmp_path):
        """The exact false give-up from the user's log: write_file twice with
        identical content — the second returns a SUCCESSFUL no-op, so the
        identical-call guard must NOT fire a 'kept failing' message."""
        import app.agent as agent
        from app.agent import run_agent_loop

        content = "print('snake game')\n" * 5
        calls = [
            json.dumps({"tool": "write_file", "args": {"path": "game.py", "content": content}}),
            json.dumps({"tool": "write_file", "args": {"path": "game.py", "content": content}}),
            "The file is already correct. Task complete.",
        ]
        original = agent.stream_chat_with_retry
        counter = {"n": 0}

        async def fake_stream(opts, messages, on_chunk, on_thinking_chunk, **kw):
            counter["n"] += 1
            resp = calls[counter["n"] - 1] if counter["n"] <= len(calls) else "Done."
            on_chunk(resp)
            return resp

        agent.stream_chat_with_retry = fake_stream
        try:
            result = asyncio.run(
                run_agent_loop(
                    {
                        "model": "fake-model",
                        "workspacePath": str(tmp_path),
                        "autoApply": True,
                        "messages": [{"role": "user", "content": "make me a snake game"}],
                        "callbacks": {"onChunk": lambda *_: None},
                    }
                )
            )
        finally:
            agent.stream_chat_with_retry = original
        assert "kept failing" not in result, f"false give-up: {result!r}"
        assert "kept being refused" not in result, f"false give-up: {result!r}"
        assert (tmp_path / "game.py").read_text(encoding="utf-8") == content
        assert counter["n"] == 3, f"loop ended early after {counter['n']} rounds"


class TestPreviewGiveUpRegression:
    """The user's live failure: no client bridge → preview_start 'failed' 3×
    → identical-call guard gave up with a misleading message. preview_start
    retries must never trip the guard; after 3 attempts the model is
    redirected to non-preview verification instead."""

    def test_repeated_preview_start_redirects_instead_of_giving_up(self, tmp_path):
        import app.agent as agent
        import app.preview as pv
        from app.agent import run_agent_loop

        (tmp_path / "index.html").write_text("<html><body>game</body></html>", encoding="utf-8")
        psc = json.dumps({"tool": "preview_start", "args": {"entry": "index.html"}})
        wsc = json.dumps({"tool": "write_file", "args": {"path": "game.js", "content": "// game logic\n"}})
        scripted = [wsc, psc, psc, psc, "Preview was unavailable here — I verified the code by reading it instead. Done."]

        async def no_bridge(payload: dict, timeout: float = 12.0) -> dict:
            raise pv.PreviewBridgeError("The desktop client's preview bridge is not connected.")

        original_stream = agent.stream_chat_with_retry
        original_call = pv.client_call
        counter = {"n": 0}

        async def fake_stream(opts, messages, on_chunk, on_thinking_chunk, **kw):
            counter["n"] += 1
            resp = scripted[counter["n"] - 1] if counter["n"] <= len(scripted) else "Done."
            on_chunk(resp)
            return resp

        agent.stream_chat_with_retry = fake_stream
        pv.client_call = no_bridge
        try:
            result = asyncio.run(
                run_agent_loop(
                    {
                        "model": "fake-model",
                        "workspacePath": str(tmp_path),
                        "autoApply": True,
                        "messages": [{"role": "user", "content": "make a web game and test it"}],
                        "callbacks": {"onChunk": lambda *_: None},
                    }
                )
            )
        finally:
            agent.stream_chat_with_retry = original_stream
            pv.client_call = original_call
            pv.stop_preview()
        assert "stopped because my preview_start" not in result, f"false give-up: {result!r}"
        assert counter["n"] == 5, f"loop gave up after {counter['n']} rounds instead of continuing"
        assert "verified the code by reading it" in result
