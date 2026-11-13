import asyncio
import sys

import pytest

from app.agent import communicate_with_stop, process_group_options


def test_stop_terminates_running_command():
    async def run():
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-c", "import time; time.sleep(30)",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            **process_group_options(),
        )
        stop = asyncio.Event()
        task = asyncio.create_task(communicate_with_stop(proc, 30, stop))
        stop.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.wait_for(proc.wait(), timeout=5)
        assert proc.returncode is not None

    asyncio.run(run())
