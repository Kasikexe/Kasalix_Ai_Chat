"""play_game tool tests.

The agent's job here is to settle BEHAVIOURAL bug reports ("the snake isn't
moving") by actually playing the game — injecting input, stepping frames, and
measuring whether the picture changes. These tests pin that contract with real
pygame runs: a moving sprite must be reported as MOTION CONFIRMED, and a stuck
sprite must be reported as NO MOTION (never silently passed).

Pygame is not a backend dependency, so the tests locate an interpreter that can
import it and point the tool at it via KASALIX_PYTHON. They skip when no such
interpreter exists.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys

import pytest

from app.agent import execute_tool

WINDOW = (200, 150)
CELL = 10

_MOVING_GAME = '''
import pygame

CELL = {cell}


def main():
    pygame.init()
    screen = pygame.display.set_mode({window})
    clock = pygame.time.Clock()
    x, y = 20, 20
    running = True
    while running:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
        keys = pygame.key.get_pressed()
        if keys[pygame.K_RIGHT]:
            x += CELL
        if keys[pygame.K_DOWN]:
            y += CELL
        if x > {maxx} - CELL:
            x = 20
        if y > {maxy} - CELL:
            y = 20
        screen.fill((0, 0, 0))
        pygame.draw.rect(screen, (0, 255, 0), (x, y, CELL, CELL))
        pygame.display.flip()
        clock.tick(60)
    pygame.quit()


main()
'''.format(cell=CELL, window=WINDOW, maxx=WINDOW[0], maxy=WINDOW[1])

# The user's actual reported bug: the player is drawn but never updated.
_STUCK_GAME = _MOVING_GAME.replace("x += CELL", "x += 0").replace("y += CELL", "y += 0")


def _interpreter_with_pygame() -> str | None:
    candidates: list[list[str]] = []
    for name in ("python", "python3"):
        found = shutil.which(name)
        if found:
            candidates.append([found])
    if not getattr(sys, "frozen", False) and sys.executable:
        candidates.append([sys.executable])
    for argv in candidates:
        try:
            probe = subprocess.run(
                [*argv, "-c", "import pygame"],
                capture_output=True,
                timeout=60,
            )
        except Exception:  # noqa: BLE001
            continue
        if probe.returncode == 0:
            return argv[0]
    return None


_PYGAME_PY = _interpreter_with_pygame()

pytestmark = pytest.mark.skipif(
    _PYGAME_PY is None, reason="no interpreter with pygame available"
)


@pytest.fixture(autouse=True)
def _use_pygame_interpreter(monkeypatch):
    monkeypatch.setenv("KASALIX_PYTHON", _PYGAME_PY or "")


def _play(root, args):
    return asyncio.run(execute_tool(str(root), {"tool": "play_game", "args": args}, True))


def test_reports_motion_when_the_sprite_actually_moves(tmp_path):
    (tmp_path / "game.py").write_text(_MOVING_GAME, encoding="utf-8")
    result = _play(
        tmp_path,
        {
            "path": "game.py",
            "frames": 60,
            "screenshotEvery": 20,
            "inputs": [{"frame": 0, "keys": ["right"]}, {"frame": 30, "keys": ["down"]}],
        },
    )
    assert result["ok"] is True, result["output"]
    assert "MOTION CONFIRMED" in result["output"], result["output"]
    assert "NO MOTION" not in result["output"], result["output"]
    frames = sorted(os.listdir(tmp_path / ".kx_frames"))
    assert len(frames) >= 3, frames


def test_reports_no_motion_when_the_player_is_stuck(tmp_path):
    """The exact user complaint: the sprite is drawn but never updated."""
    (tmp_path / "game.py").write_text(_STUCK_GAME, encoding="utf-8")
    result = _play(
        tmp_path,
        {"path": "game.py", "frames": 60, "screenshotEvery": 20, "inputs": [{"frame": 0, "keys": ["right"]}]},
    )
    assert "NO MOTION" in result["output"], result["output"]
    assert "MOTION CONFIRMED" not in result["output"], result["output"]


def test_crash_is_reported_and_is_not_ok(tmp_path):
    (tmp_path / "game.py").write_text(
        "import pygame\npygame.init()\nraise ValueError('kaboom')\n", encoding="utf-8"
    )
    result = _play(tmp_path, {"path": "game.py", "frames": 30})
    assert result["ok"] is False
    assert "CRASHED" in result["output"]
    assert "kaboom" in result["output"]


def test_captured_frames_land_inside_the_workspace(tmp_path):
    (tmp_path / "game.py").write_text(_MOVING_GAME, encoding="utf-8")
    result = _play(tmp_path, {"path": "game.py", "frames": 40, "screenshotEvery": 10})
    assert result["ok"] is True, result["output"]
    shots = sorted(os.listdir(tmp_path / ".kx_frames"))
    assert shots, "no frames captured"
    for name in shots:
        assert name.endswith(".png")


# A game whose SCORE lives at module level — the agent must be able to read it
# back to verify logic, not just look at pixels.
_SCORING_GAME = '''
import pygame

CELL = 10
score = 0
apples_eaten = 0
game_over = False
player_x = 20


def main():
    global score, apples_eaten, player_x
    pygame.init()
    screen = pygame.display.set_mode((200, 150))
    clock = pygame.time.Clock()
    running = True
    while running:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
        keys = pygame.key.get_pressed()
        if keys[pygame.K_RIGHT]:
            player_x += CELL
        score += 1
        apples_eaten = score // 10
        screen.fill((0, 0, 0))
        pygame.draw.rect(screen, (0, 255, 0), (player_x % 180, 20, CELL, CELL))
        pygame.display.flip()
        clock.tick(60)
    pygame.quit()


main()
'''


def test_game_logic_state_is_visible_to_the_agent(tmp_path):
    (tmp_path / "game.py").write_text(_SCORING_GAME, encoding="utf-8")
    result = _play(
        tmp_path,
        {
            "path": "game.py",
            "frames": 40,
            "screenshotEvery": 20,
            "inputs": [{"frame": 0, "keys": ["right"]}],
        },
    )
    assert result["ok"] is True, result["output"]
    assert "Game state at exit" in result["output"], result["output"]
    state = dict(re.findall(r"^  (\w+) = (.+)$", result["output"], re.M))
    assert int(state["score"]) >= 40, state
    assert int(state["apples_eaten"]) == int(state["score"]) // 10, state
    assert state["game_over"] == "false", state
    # Input was actually applied to the game's own logic, not just the pixels.
    assert int(state["player_x"]) > 20, state


# ─────────────────────────────────────────────────────────────
# Automatic replay: detect → play after edits → block false "fixed"
# ─────────────────────────────────────────────────────────────


def _run_loop(workspace: str, responses: list[str], message: str = "the snake isn't moving, please fix it"):
    """Drive the REAL agent loop with a scripted model."""
    import app.agent as agent

    counter = {"n": 0}

    async def fake_stream(opts, messages, on_chunk, on_thinking_chunk, **kw):
        counter["n"] += 1
        resp = responses[counter["n"] - 1] if counter["n"] <= len(responses) else "Task complete."
        on_chunk(resp)
        return resp

    original = agent.stream_chat_with_retry
    agent.stream_chat_with_retry = fake_stream
    try:
        result = asyncio.run(
            agent.run_agent_loop(
                {
                    "model": "fake-model",
                    "workspacePath": workspace,
                    "autoApply": True,
                    "messages": [{"role": "user", "content": message}],
                    "callbacks": {"onChunk": lambda *_: None},
                }
            )
        )
        return result, counter["n"]
    finally:
        agent.stream_chat_with_retry = original


def test_detects_a_pygame_entry_script(tmp_path):
    import app.agent as agent

    (tmp_path / "snake.py").write_text(_MOVING_GAME, encoding="utf-8")
    (tmp_path / "util.py").write_text("x = 1\n", encoding="utf-8")
    target = asyncio.run(agent.detect_game_target(str(tmp_path)))
    assert target is not None
    assert target["path"] == "snake.py"
    assert target["frames"] >= 20
    assert target["inputs"], "default input sweep must be present"


def test_no_game_detected_without_pygame(tmp_path):
    import app.agent as agent

    (tmp_path / "tool.py").write_text("print('hello')\n", encoding="utf-8")
    assert asyncio.run(agent.detect_game_target(str(tmp_path))) is None


def test_game_detection_can_be_disabled_and_overridden(tmp_path):
    import app.agent as agent

    (tmp_path / "snake.py").write_text(_MOVING_GAME, encoding="utf-8")
    (tmp_path / "other.py").write_text(_MOVING_GAME, encoding="utf-8")
    (tmp_path / ".agent-config.json").write_text(
        json.dumps({"gamePath": "other.py", "gameFrames": 60}), encoding="utf-8"
    )
    target = asyncio.run(agent.detect_game_target(str(tmp_path)))
    assert target["path"] == "other.py"
    assert target["frames"] == 60

    (tmp_path / ".agent-config.json").write_text(json.dumps({"gameEnabled": False}), encoding="utf-8")
    assert asyncio.run(agent.detect_game_target(str(tmp_path))) is None


def test_no_motion_counts_as_a_failed_check(tmp_path, monkeypatch):
    """A clean run with a frozen sprite must NOT count as a pass."""
    import app.agent as agent

    (tmp_path / "snake.py").write_text(_STUCK_GAME, encoding="utf-8")
    target = asyncio.run(agent.detect_game_target(str(tmp_path)))
    check = asyncio.run(agent.run_game_check(str(tmp_path), target))
    assert check["verdict"] == "no_motion", check
    assert check["ok"] is False, check


def test_moving_game_counts_as_a_passing_check(tmp_path):
    import app.agent as agent

    (tmp_path / "snake.py").write_text(_MOVING_GAME, encoding="utf-8")
    target = asyncio.run(agent.detect_game_target(str(tmp_path)))
    check = asyncio.run(agent.run_game_check(str(tmp_path), target))
    assert check["ok"] is True, check
    assert check["verdict"] == "motion", check


def test_replays_after_edit_and_blocks_a_false_fixed_claim(tmp_path):
    """The user's exact failure: a fix that does not work, then "it should be
    fixed now". The game check must catch it and the claim must be refused."""
    (tmp_path / "snake.py").write_text(_STUCK_GAME, encoding="utf-8")
    responses = [
        # Still stuck — moves nothing.
        '{"tool": "write_file", "args": {"path": "snake.py", "content": ' + json.dumps(_STUCK_GAME) + '}}',
        "I fixed it — the snake should now move.",
        "It is still broken: my headless play test reports no motion, so the input still is not applied.",
    ]
    result, rounds = _run_loop(str(tmp_path), responses)
    assert "should now move" not in result, f"false 'fixed' claim shipped: {result!r}"
    assert "still broken" in result, f"honest reply never surfaced: {result!r}"
    assert rounds >= 3, rounds


def test_passing_check_lets_the_agent_finish(tmp_path):
    (tmp_path / "snake.py").write_text(_STUCK_GAME, encoding="utf-8")
    responses = [
        '{"tool": "write_file", "args": {"path": "snake.py", "content": ' + json.dumps(_MOVING_GAME) + '}}',
        "Fixed it — the snake moves now.",
    ]
    result, _ = _run_loop(str(tmp_path), responses)
    assert "moves now" in result, f"a passing check blocked a valid finish: {result!r}"


def test_automatic_replays_are_capped(tmp_path, monkeypatch):
    import app.agent as agent

    (tmp_path / "snake.py").write_text(_STUCK_GAME, encoding="utf-8")
    calls = {"n": 0}

    async def fake_check(root, game_target, **kw):
        calls["n"] += 1
        return {"ok": False, "verdict": "no_motion", "output": "NO MOTION between the captured frames."}

    monkeypatch.setattr(agent, "run_game_check", fake_check)
    responses = [
        '{"tool": "write_file", "args": {"path": "snake.py", "content": ' + json.dumps(_STUCK_GAME.replace("CELL = 10", "CELL = %d" % (10 + i))) + '}}'
        for i in range(12)
    ]
    _run_loop(str(tmp_path), responses)
    assert calls["n"] >= 3, f"replay never became autonomous: {calls}"
    assert calls["n"] <= agent.GAME_VERIFY_CAP, f"replays not capped: {calls}"


# ─────────────────────────────────────────────────────────────
# Seeing the game: raw frame attached for vision-capable models
# ─────────────────────────────────────────────────────────────


def test_final_frame_is_attached_for_a_vision_capable_model(tmp_path):
    """A vision-capable code model must get real PIXELS, not prose."""
    (tmp_path / "game.py").write_text(_MOVING_GAME, encoding="utf-8")
    result = asyncio.run(
        execute_tool(
            str(tmp_path),
            {"tool": "play_game", "args": {"path": "game.py", "frames": 30, "screenshotEvery": 10}},
            True,
            extra={"use_vision_model": True},
        )
    )
    assert result["ok"] is True, result["output"]
    assert result.get("imageData", "").startswith("data:image/png;base64,"), result.keys()
    assert "ATTACHED" in result["output"], result["output"]


def test_automatic_replays_do_not_call_the_vision_model(tmp_path):
    """The autonomous loop only needs the verdict — no image, no extra model call."""
    (tmp_path / "game.py").write_text(_MOVING_GAME, encoding="utf-8")
    result = asyncio.run(
        execute_tool(
            str(tmp_path),
            {"tool": "play_game", "args": {"path": "game.py", "frames": 30, "screenshotEvery": 10}},
            True,
            extra={"use_vision_model": False, "game_auto": True},
        )
    )
    assert "imageData" not in result, "automatic replay attached an image"
    assert "vision model" not in result["output"], "automatic replay called the vision model"


def test_requires_a_path(tmp_path):
    result = _play(tmp_path, {})
    assert result["ok"] is False
    assert "path" in result["output"]


def test_rejects_missing_script(tmp_path):
    result = _play(tmp_path, {"path": "nope.py", "frames": 10})
    assert result["ok"] is False
