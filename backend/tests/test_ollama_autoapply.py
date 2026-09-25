"""Auto-apply of saved Ollama tuning at backend startup.

When the backend boots and finds Ollama already running EXTERNALLY (tray
autostart at PC boot), the host's saved tuning (parallel slots, keep-alive,
KV cache type…) is not active — the tray gave Ollama its own env. The
backend must restart Ollama with the saved settings instead of waiting for
a manual Save & Restart. These tests pin the decision matrix.
"""

import pytest

from app.routes import ollama as ollama_mod


@pytest.fixture()
def reset_state(monkeypatch, tmp_path):
    """Fresh module state for each test (incl. a non-existent ownership flag —
    the real one can exist on a dev machine where the app spawned Ollama)."""
    monkeypatch.setattr(ollama_mod, "_owned_by_us", False)
    monkeypatch.setattr(ollama_mod, "_restarting", False)
    monkeypatch.setattr(ollama_mod, "OWNERSHIP_FLAG", str(tmp_path / "ownership-flag"))
    yield


class TestAutoApplyExternalOllama:
    async def test_applies_saved_settings_to_external_ollama(self, monkeypatch, reset_state):
        """External Ollama + saved tuning → restart with that tuning."""
        calls = {}

        async def fake_running():
            return True

        async def fake_loaded():
            return []

        async def fake_settings():
            return {"ollamaNumParallel": 2, "ollamaMaxLoadedModels": 0, "ollamaKeepAlive": "30m", "kvCacheType": "q8_0", "kvCacheOffload": True}

        async def fake_restart(kv_offload, kv_type, confirm=False, num_parallel=0, max_loaded_models=0, keep_alive=""):
            calls["args"] = {
                "kv_offload": kv_offload,
                "kv_type": kv_type,
                "confirm": confirm,
                "num_parallel": num_parallel,
                "max_loaded_models": max_loaded_models,
                "keep_alive": keep_alive,
            }
            return {"success": True}

        monkeypatch.setattr(ollama_mod, "is_ollama_running", fake_running)
        monkeypatch.setattr(ollama_mod, "get_loaded_models", fake_loaded)
        monkeypatch.setattr(ollama_mod, "load_settings", fake_settings)
        monkeypatch.setattr(ollama_mod, "restart_ollama", fake_restart)

        await ollama_mod.auto_apply_settings_if_external()

        assert calls["args"] == {
            "kv_offload": True,
            "kv_type": "q8_0",
            "confirm": True,
            "num_parallel": 2,
            "max_loaded_models": 0,
            "keep_alive": "30m",
        }

    async def test_skips_when_ollama_not_running(self, monkeypatch, reset_state):
        async def fake_running():
            return False

        called = False

        async def fake_restart(*a, **k):
            nonlocal called
            called = True
            return {"success": True}

        monkeypatch.setattr(ollama_mod, "is_ollama_running", fake_running)
        monkeypatch.setattr(ollama_mod, "restart_ollama", fake_restart)

        await ollama_mod.auto_apply_settings_if_external()
        assert called is False

    async def test_skips_when_owned_by_app(self, monkeypatch, reset_state):
        """App-spawned Ollama already has the right env — never restart it."""
        monkeypatch.setattr(ollama_mod, "_owned_by_us", True)

        called = False

        async def fake_running():
            return True

        async def fake_restart(*a, **k):
            nonlocal called
            called = True
            return {"success": True}

        monkeypatch.setattr(ollama_mod, "is_ollama_running", fake_running)
        monkeypatch.setattr(ollama_mod, "restart_ollama", fake_restart)

        await ollama_mod.auto_apply_settings_if_external()
        assert called is False

    async def test_skips_when_all_settings_auto(self, monkeypatch, reset_state):
        """Nothing saved (all Auto) → nothing to apply, leave the tray Ollama alone."""
        called = False

        async def fake_running():
            return True

        async def fake_loaded():
            return []

        async def fake_settings():
            return {"ollamaNumParallel": 0, "ollamaMaxLoadedModels": 0, "ollamaKeepAlive": "", "kvCacheType": "f16", "kvCacheOffload": True}

        async def fake_restart(*a, **k):
            nonlocal called
            called = True
            return {"success": True}

        monkeypatch.setattr(ollama_mod, "is_ollama_running", fake_running)
        monkeypatch.setattr(ollama_mod, "get_loaded_models", fake_loaded)
        monkeypatch.setattr(ollama_mod, "load_settings", fake_settings)
        monkeypatch.setattr(ollama_mod, "restart_ollama", fake_restart)

        await ollama_mod.auto_apply_settings_if_external()
        assert called is False

    async def test_skips_when_models_loaded(self, monkeypatch, reset_state):
        """Loaded models mean active generation elsewhere — never yank it at boot."""
        called = False

        async def fake_running():
            return True

        async def fake_loaded():
            return [{"name": "qwen3:8b"}]

        async def fake_settings():
            return {"ollamaNumParallel": 2, "ollamaMaxLoadedModels": 0, "ollamaKeepAlive": "", "kvCacheType": "f16", "kvCacheOffload": True}

        async def fake_restart(*a, **k):
            nonlocal called
            called = True
            return {"success": True}

        monkeypatch.setattr(ollama_mod, "is_ollama_running", fake_running)
        monkeypatch.setattr(ollama_mod, "get_loaded_models", fake_loaded)
        monkeypatch.setattr(ollama_mod, "load_settings", fake_settings)
        monkeypatch.setattr(ollama_mod, "restart_ollama", fake_restart)

        await ollama_mod.auto_apply_settings_if_external()
        assert called is False

    async def test_skips_when_ownership_flag_exists(self, monkeypatch, reset_state, tmp_path):
        """Flag on disk with a LIVE PID AND env = an app-spawned Ollama still
        running with the app's saved tuning."""
        import unittest.mock as mock
        import json as _json

        async def fake_running():
            return True

        called = False

        async def fake_restart(*a, **k):
            nonlocal called
            called = True
            return {"success": True}

        monkeypatch.setattr(ollama_mod, "is_ollama_running", fake_running)
        monkeypatch.setattr(ollama_mod, "restart_ollama", fake_restart)
        monkeypatch.setattr(ollama_mod, "_ownership_pid_alive", lambda: True)
        with mock.patch.object(ollama_mod, "OWNERSHIP_FLAG", str(tmp_path / "flag")):
            (tmp_path / "flag").write_text(_json.dumps({"pid": 123, "env": {"OLLAMA_NUM_PARALLEL": "2"}}))
            await ollama_mod.auto_apply_settings_if_external()
        assert called is False

    async def test_legacy_envless_flag_fires_autoapply(self, monkeypatch, reset_state, tmp_path):
        """A plain-pid (pre-env) flag proves nothing about the env Ollama has
        — auto-apply must run so the saved tuning gets applied (and the flag
        upgraded to the JSON format)."""
        import unittest.mock as mock

        async def fake_running():
            return True

        calls = {}

        async def fake_restart(*a, **k):
            calls["fired"] = True
            return {"success": True}

        monkeypatch.setattr(ollama_mod, "is_ollama_running", fake_running)
        monkeypatch.setattr(ollama_mod, "restart_ollama", fake_restart)
        monkeypatch.setattr(ollama_mod, "_ownership_pid_alive", lambda: True)
        with mock.patch.object(ollama_mod, "OWNERSHIP_FLAG", str(tmp_path / "flag")):
            (tmp_path / "flag").write_text("123")
            await ollama_mod.auto_apply_settings_if_external()
        assert calls.get("fired") is True


class TestEnsureOllamaAtStartup:
    """Startup hook that respawns Ollama when it is DEAD after a server restart."""

    @pytest.fixture(autouse=True)
    def zero_grace(self, monkeypatch):
        monkeypatch.setattr(ollama_mod, "_STARTUP_GRACE_S", 0.0)

    async def test_spawns_ollama_when_dead(self, monkeypatch, reset_state):
        """Ollama not running at boot → restart_ollama with saved tuning."""
        calls = {}

        async def fake_running():
            return False

        async def fake_settings():
            return {"ollamaNumParallel": 4, "ollamaMaxLoadedModels": 2, "ollamaKeepAlive": "10m", "kvCacheType": "q8_0", "kvCacheOffload": True}

        async def fake_restart(kv_offload, kv_type, confirm=False, num_parallel=0, max_loaded_models=0, keep_alive=""):
            calls["args"] = {"kv_offload": kv_offload, "kv_type": kv_type, "confirm": confirm, "num_parallel": num_parallel, "max_loaded_models": max_loaded_models, "keep_alive": keep_alive}
            return {"success": True}

        monkeypatch.setattr(ollama_mod, "is_ollama_running", fake_running)
        monkeypatch.setattr(ollama_mod, "load_settings", fake_settings)
        monkeypatch.setattr(ollama_mod, "restart_ollama", fake_restart)

        await ollama_mod.ensure_ollama_running_at_startup()

        assert calls["args"] == {
            "kv_offload": True,
            "kv_type": "q8_0",
            "confirm": True,
            "num_parallel": 4,
            "max_loaded_models": 2,
            "keep_alive": "10m",
        }

    async def test_skips_when_already_running(self, monkeypatch, reset_state):
        async def fake_running():
            return True

        called = False

        async def fake_restart(*a, **k):
            nonlocal called
            called = True
            return {"success": True}

        monkeypatch.setattr(ollama_mod, "is_ollama_running", fake_running)
        monkeypatch.setattr(ollama_mod, "restart_ollama", fake_restart)

        await ollama_mod.ensure_ollama_running_at_startup()
        assert called is False

    async def test_survives_spawn_failure(self, monkeypatch, reset_state):
        """A failed spawn must not raise — startup continues without Ollama."""
        async def fake_running():
            return False

        async def fake_restart(*a, **k):
            return {"success": False, "error": "no exe"}

        monkeypatch.setattr(ollama_mod, "is_ollama_running", fake_running)
        monkeypatch.setattr(ollama_mod, "load_settings", lambda: _async({}))
        monkeypatch.setattr(ollama_mod, "restart_ollama", fake_restart)

        await ollama_mod.ensure_ollama_running_at_startup()  # must not raise

    async def test_survives_load_settings_crash(self, monkeypatch, reset_state):
        async def fake_running():
            return False

        async def boom():
            raise RuntimeError("disk gone")

        monkeypatch.setattr(ollama_mod, "is_ollama_running", fake_running)
        monkeypatch.setattr(ollama_mod, "load_settings", boom)

        await ollama_mod.ensure_ollama_running_at_startup()  # must not raise


async def _async(value):
    async def _inner():
        return value

    return _inner()


class TestStaleOwnershipFlag:
    """A flag whose PID is dead must not count as ownership — it suppresses
    both startup hooks and froze an external Ollama on its old env."""

    async def test_detect_marks_stale_flag_external(self, monkeypatch, reset_state, tmp_path):
        import unittest.mock as mock

        async def fake_running():
            return True

        monkeypatch.setattr(ollama_mod, "is_ollama_running", fake_running)
        monkeypatch.setattr(ollama_mod, "_ownership_pid_alive", lambda: False)
        with mock.patch.object(ollama_mod, "OWNERSHIP_FLAG", str(tmp_path / "flag")):
            (tmp_path / "flag").write_text("16600")
            await ollama_mod.detect_ollama_ownership()
        assert ollama_mod._owned_by_us is False
        assert not (tmp_path / "flag").exists()  # stale flag cleaned up

    async def test_detect_keeps_alive_flag_owned(self, monkeypatch, reset_state, tmp_path):
        import unittest.mock as mock
        import json as _json

        async def fake_running():
            return True

        monkeypatch.setattr(ollama_mod, "is_ollama_running", fake_running)
        monkeypatch.setattr(ollama_mod, "_ownership_pid_alive", lambda: True)
        with mock.patch.object(ollama_mod, "OWNERSHIP_FLAG", str(tmp_path / "flag")):
            (tmp_path / "flag").write_text(_json.dumps({"pid": 1234, "env": {"OLLAMA_NUM_PARALLEL": "2"}}))
            await ollama_mod.detect_ollama_ownership()
        assert ollama_mod._owned_by_us is True
        assert ollama_mod._effective_env.get("OLLAMA_NUM_PARALLEL") == "2"

    async def test_autoapply_fires_despite_stale_flag(self, monkeypatch, reset_state, tmp_path):
        """The real-world failure: stale flag + external Ollama with saved
        tuning → auto-apply must restart it (previously silently skipped)."""
        import unittest.mock as mock

        calls = {}

        async def fake_running():
            return True

        async def fake_loaded():
            return []

        async def fake_settings():
            return {"ollamaNumParallel": 2, "ollamaMaxLoadedModels": 2, "ollamaKeepAlive": "10m", "kvCacheType": "q8_0", "kvCacheOffload": True}

        async def fake_restart(kv_offload, kv_type, confirm=False, num_parallel=0, max_loaded_models=0, keep_alive=""):
            calls["fired"] = True
            calls["num_parallel"] = num_parallel
            return {"success": True}

        monkeypatch.setattr(ollama_mod, "is_ollama_running", fake_running)
        monkeypatch.setattr(ollama_mod, "get_loaded_models", fake_loaded)
        monkeypatch.setattr(ollama_mod, "load_settings", fake_settings)
        monkeypatch.setattr(ollama_mod, "restart_ollama", fake_restart)
        monkeypatch.setattr(ollama_mod, "_ownership_pid_alive", lambda: False)
        with mock.patch.object(ollama_mod, "OWNERSHIP_FLAG", str(tmp_path / "flag")):
            (tmp_path / "flag").write_text("16600")  # stale
            await ollama_mod.auto_apply_settings_if_external()
        assert calls.get("fired") is True
        assert calls.get("num_parallel") == 2

    def test_pid_liveness_rejects_garbage_and_dead(self, tmp_path):
        import unittest.mock as mock

        with mock.patch.object(ollama_mod, "OWNERSHIP_FLAG", str(tmp_path / "flag")):
            (tmp_path / "flag").write_text("not-a-pid")
            assert ollama_mod._ownership_pid_alive() is False
            (tmp_path / "flag").write_text("0")
            assert ollama_mod._ownership_pid_alive() is False
            # A PID that is essentially impossible to reuse on Windows:
            (tmp_path / "flag").write_text("999999")
            assert ollama_mod._ownership_pid_alive() is False

    def test_flag_roundtrip_json_and_legacy(self, tmp_path):
        """JSON flag parses pid+env; plain-pid legacy parses as env-less."""
        import unittest.mock as mock
        import json as _json

        with mock.patch.object(ollama_mod, "OWNERSHIP_FLAG", str(tmp_path / "flag")):
            ollama_mod._write_ownership_flag(4242, {"OLLAMA_KEEP_ALIVE": "10m"})
            data = ollama_mod._read_ownership_flag()
            assert data == {"pid": 4242, "env": {"OLLAMA_KEEP_ALIVE": "10m"}}

            (tmp_path / "flag").write_text("16600")
            data = ollama_mod._read_ownership_flag()
            assert data == {"pid": 16600, "env": None}

    async def test_status_reports_effective_env_after_detection(self, monkeypatch, reset_state, tmp_path):
        """The user-facing bug: owned Ollama after a backend restart must
        still report WHAT it is running with (env restored from flag)."""
        import unittest.mock as mock
        import json as _json

        async def fake_running():
            return True

        monkeypatch.setattr(ollama_mod, "is_ollama_running", fake_running)
        monkeypatch.setattr(ollama_mod, "_ownership_pid_alive", lambda: True)
        with mock.patch.object(ollama_mod, "OWNERSHIP_FLAG", str(tmp_path / "flag")):
            (tmp_path / "flag").write_text(_json.dumps({
                "pid": 1234,
                "env": {"OLLAMA_NUM_PARALLEL": "2", "OLLAMA_KEEP_ALIVE": "10m", "LLAMA_ARG_CACHE_TYPE_K": "q8_0"},
            }))
            await ollama_mod.detect_ollama_ownership()
        status = ollama_mod.get_ollama_status()
        assert status["ownedByUs"] is True
        assert status["effectiveEnv"]["OLLAMA_NUM_PARALLEL"] == "2"
        assert status["effectiveEnv"]["LLAMA_ARG_CACHE_TYPE_K"] == "q8_0"


class TestParallelUnsupportedDetection:
    """Ollama warns 'model architecture does not currently support parallel
    requests' per-arch (seen live with qwen35) — surface it in /status."""

    def test_parses_arch_from_stderr_line(self, monkeypatch):
        monkeypatch.setattr(ollama_mod, "_parallel_unsupported_archs", set())
        ollama_mod._note_parallel_unsupported(
            'time=... level=WARN source=sched.go:514 msg="model architecture '
            'does not currently support parallel requests" architecture=qwen35'
        )
        assert ollama_mod._parallel_unsupported_archs == {"qwen35"}

    def test_ignores_unrelated_lines(self, monkeypatch):
        monkeypatch.setattr(ollama_mod, "_parallel_unsupported_archs", set())
        ollama_mod._note_parallel_unsupported("srv update_slots: all slots are idle")
        ollama_mod._note_parallel_unsupported("does not currently support")  # no arch=
        assert ollama_mod._parallel_unsupported_archs == set()

    def test_status_exposes_archs(self):
        status = ollama_mod.get_ollama_status()
        assert "parallelUnsupportedArchs" in status
