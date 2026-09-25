"""Headless pygame harness for the play_game agent tool.

`HARNESS_SOURCE` is a STANDALONE Python program (stdlib + pygame only). The
play_game tool writes it to a temp file and runs it with the PROJECT's
interpreter — so it must never import anything from this package.

It runs a game script under runpy with deterministic timing, injects scripted
keyboard input, captures frames as PNGs, and measures frame-to-frame pixel
motion. That last part is what turns "the snake isn't moving" from a guess
into a measurement: if the game should be animating and consecutive captured
frames are pixel-identical, the harness says so outright.
"""

HARNESS_SOURCE = r'''
# Standalone headless pygame harness (no imports from the Kasalix package).
# Writes a JSON result file; the parent tool reads it back.
import json
import os
import runpy
import sys
import threading
import time
import traceback

with open(sys.argv[1], "r", encoding="utf-8") as _fh:
    PLAN = json.load(_fh)

TARGET = PLAN["target"]
FRAME_LIMIT = int(PLAN.get("frames") or 120)
SHOT_EVERY = int(PLAN.get("screenshotEvery") or 0)
OUTDIR = PLAN["outDir"]
RESULT_PATH = PLAN["resultPath"]
WALL_LIMIT = float(PLAN.get("wallLimit") or 30)
FPS = int(PLAN.get("fps") or 60)
INPUTS = sorted(PLAN.get("inputs") or [], key=lambda e: int(e.get("frame") or 0))

RESULT = {
    "ok": False,
    "frames": 0,
    "shots": [],
    "error": None,
    "notes": [],
    "pygameVersion": None,
    "window": None,
    "state": {},
    "finished": False,
}

_SKIP_STATE_NAMES = {
    "pygame", "sys", "os", "json", "runpy", "time", "threading", "traceback",
    "math", "random", "main", "globals", "locals", "self", "cls",
}


def snapshot_state(namespace):
    # Module-level scalar state (score, lives, game_over, player position...)
    # so the agent can check game LOGIC, not just the pixels. Values local to
    # main() are not visible to Python here and cannot be captured.
    safe = {}
    for name, value in list(namespace.items()):
        if name.startswith("_") or name in _SKIP_STATE_NAMES:
            continue
        if isinstance(value, bool) or isinstance(value, (int, float)):
            safe[name] = value
        elif isinstance(value, str):
            safe[name] = value[:120] + ("..." if len(value) > 120 else "")
        elif isinstance(value, (list, tuple)) and len(value) <= 24 and all(
            isinstance(v, (int, float, str, bool)) for v in value
        ):
            safe[name] = list(value)
        elif isinstance(value, dict) and len(value) <= 24 and all(
            isinstance(k, str) and isinstance(v, (int, float, str, bool))
            for k, v in value.items()
        ):
            safe[name] = dict(value)
        if len(safe) >= 30:
            break
    RESULT["state"] = safe
_LOCK = threading.Lock()


def flush():
    with _LOCK:
        tmp = RESULT_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(RESULT, fh)
        os.replace(tmp, RESULT_PATH)


class StopGame(Exception):
    pass


def watchdog():
    deadline = time.time() + WALL_LIMIT
    while time.time() < deadline:
        time.sleep(0.1)
    with _LOCK:
        RESULT["notes"].append(
            "stopped by the wall-clock limit (%.0fs) — the game loop never "
            "yielded to the frame counter" % WALL_LIMIT
        )
        RESULT["frames"] = STATE["frame"]
        RESULT["ok"] = True
        RESULT["finished"] = True
    flush()
    os._exit(0)


def main():
    os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
    os.environ.setdefault("SDL_AUDIODRIVER", "dummy")
    os.environ["PYGAME_HIDE_SUPPORT_PROMPT"] = "1"

    try:
        import pygame
    except Exception as exc:  # noqa: BLE001
        RESULT["error"] = "pygame is not importable by this interpreter: %s" % exc
        flush()
        return

    RESULT["pygameVersion"] = getattr(getattr(pygame, "version", None), "ver", None) or "?"

    # ── Deterministic, instant clock (no real-time sleeping per frame) ──
    class _FakeClock:
        def __init__(self, *a, **k):
            pass

        def tick(self, fps=0):
            return int(1000 / (fps or FPS))

        def tick_busy_loop(self, fps=0):
            return int(1000 / (fps or FPS))

        def get_fps(self):
            return float(FPS)

        def get_time(self):
            return int(1000 / FPS)

        def get_rawtime(self):
            return 0

    pygame.time.Clock = _FakeClock

    # ── Audio: never fail headless (no sound device) ──
    try:
        import types as _types

        mixer = pygame.mixer

        class _DummySound:
            def play(self, *a, **k):
                return None

            def stop(self, *a, **k):
                return None

            def fadeout(self, *a, **k):
                return None

            def set_volume(self, *a, **k):
                return None

            def get_length(self):
                return 0.0

        mixer.init = lambda *a, **k: None
        mixer.quit = lambda *a, **k: None
        mixer.Sound = lambda *a, **k: _DummySound()
        mixer.music = _types.SimpleNamespace(
            load=lambda *a, **k: None,
            play=lambda *a, **k: None,
            stop=lambda *a, **k: None,
            pause=lambda *a, **k: None,
            unpause=lambda *a, **k: None,
            set_volume=lambda *a, **k: None,
            get_busy=lambda *a, **k: False,
        )
    except Exception:  # noqa: BLE001
        pass

    # ── Scripted input ──
    ALIASES = {
        "left": "K_LEFT", "right": "K_RIGHT", "up": "K_UP", "down": "K_DOWN",
        "space": "K_SPACE", "spacebar": "K_SPACE", "return": "K_RETURN",
        "enter": "K_RETURN", "escape": "K_ESCAPE", "esc": "K_ESCAPE",
        "shift": "K_LSHIFT", "tab": "K_TAB", "backspace": "K_BACKSPACE",
    }

    def resolve_key(name):
        key = str(name).strip().lower()
        attr = ALIASES.get(key) or ("K_" + key.upper())
        return getattr(pygame, attr, None)

    STATE = {"frame": 0, "held": set(), "emitted_frame": -1}

    def held_at(frame):
        held = set()
        for entry in INPUTS:
            if frame >= int(entry.get("frame") or 0):
                held = {resolve_key(k) for k in (entry.get("keys") or [])}
                held.discard(None)
        return held

    def scripted_events():
        # Emit KEYDOWN/KEYUP only once per frame, and only on change.
        if STATE["emitted_frame"] == STATE["frame"]:
            return []
        STATE["emitted_frame"] = STATE["frame"]
        want = held_at(STATE["frame"])
        events = []
        for key in want - STATE["held"]:
            events.append(pygame.event.Event(pygame.KEYDOWN, {"key": key, "mod": 0, "unicode": "", "scancode": 0}))
        for key in STATE["held"] - want:
            events.append(pygame.event.Event(pygame.KEYUP, {"key": key, "mod": 0, "unicode": "", "scancode": 0}))
        STATE["held"] = want
        if STATE["frame"] >= FRAME_LIMIT:
            events.append(pygame.event.Event(pygame.QUIT))
        return events

    _real_get = pygame.event.get

    def patched_get(*a, **k):
        try:
            events = list(_real_get(*a, **k))
        except Exception:  # noqa: BLE001
            events = []
        events.extend(scripted_events())
        return events

    pygame.event.get = patched_get

    class _Keys:
        def __init__(self, held):
            self._held = held

        def __getitem__(self, key):
            return key in self._held

        def __len__(self):
            return 512

        def __iter__(self):
            return iter([])

    pygame.key.get_pressed = lambda *a, **k: _Keys(held_at(STATE["frame"]))

    # ── Frame counting, capture and motion measurement ──
    _prev_bytes = {"data": None}

    def capture(frame):
        try:
            surface = pygame.display.get_surface()
            if surface is None:
                return
            if RESULT["window"] is None:
                RESULT["window"] = "%dx%d" % surface.get_size()
            shot_path = os.path.join(OUTDIR, "frame_%05d.png" % frame)
            pygame.image.save(surface, shot_path)
            changed = None
            try:
                raw = pygame.image.tostring(surface, "RGB")
                if _prev_bytes["data"] is not None and len(raw) == len(_prev_bytes["data"]):
                    changed = sum(
                        1 for i in range(0, len(raw), 3)
                        if raw[i:i + 3] != _prev_bytes["data"][i:i + 3]
                    )
                _prev_bytes["data"] = raw
            except Exception:  # noqa: BLE001
                pass
            RESULT["shots"].append({"frame": frame, "path": shot_path, "changedPixels": changed})
        except Exception as exc:  # noqa: BLE001
            RESULT["notes"].append("frame capture failed at %d: %s" % (frame, exc))

    def on_frame():
        STATE["frame"] += 1
        frame = STATE["frame"]
        if frame == 1 or (SHOT_EVERY and frame % SHOT_EVERY == 0):
            capture(frame)
        if frame > FRAME_LIMIT * 2:
            raise StopGame()

    _real_flip = pygame.display.flip
    _real_update = pygame.display.update

    def patched_flip(*a, **k):
        on_frame()
        return _real_flip(*a, **k)

    def patched_update(*a, **k):
        on_frame()
        return _real_update(*a, **k)

    pygame.display.flip = patched_flip
    pygame.display.update = patched_update

    os.makedirs(OUTDIR, exist_ok=True)
    threading.Thread(target=watchdog, daemon=True).start()

    sys.argv = [TARGET] + list(PLAN.get("args") or [])
    try:
        namespace = runpy.run_path(TARGET, run_name="__main__")
        RESULT["ok"] = True
        if isinstance(namespace, dict):
            snapshot_state(namespace)
    except StopGame:
        RESULT["ok"] = True
        RESULT["notes"].append(
            "game ignored the quit event and was stopped at the %d-frame backstop" % (FRAME_LIMIT * 2)
        )
    except SystemExit:
        RESULT["ok"] = True
    except BaseException:
        RESULT["error"] = traceback.format_exc(limit=8)
    finally:
        RESULT["frames"] = STATE["frame"]
        if not RESULT["shots"]:
            capture(max(STATE["frame"], 1))
        RESULT["finished"] = True
        flush()


if __name__ == "__main__":
    main()
'''
