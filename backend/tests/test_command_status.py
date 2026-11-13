import asyncio

import pytest

from app import agent


@pytest.mark.parametrize("exit_code", [0, 7])
def test_commands_and_verification_use_exit_code(monkeypatch, exit_code):
    class Process:
        returncode = exit_code

        async def communicate(self):
            return b"output", b""

    async def spawn(*args, **kwargs):
        return Process()

    monkeypatch.setattr(asyncio, "create_subprocess_shell", spawn)
    verify = asyncio.run(agent._run_verify("test", ".", 3000))
    assert verify.startswith("FAILED") is (exit_code != 0)
    if exit_code:
        assert f"exit code {exit_code}" in verify
