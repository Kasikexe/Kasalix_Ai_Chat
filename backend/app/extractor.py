"""Memory extraction — mirrors backend/src/services/extractor.ts.

Runs async after the assistant responds; analyzes ONLY the user's message so
the AI's own hallucinations never get saved as memory.
"""

from __future__ import annotations

import json
import re

from .logger import error as log_error, info as log_info
from .memory import get_memory, merge_memory_entries
from .model_assignments import get_resolved_model
from .ollama_client import StreamOptions, stream_chat
from .settings_store import get_cloud_settings


async def extract_memory_from_turn(user_id: str, user_message: str) -> None:
    try:
        current = await get_memory(user_id)
        if not current.get("enabled"):
            return

        memory_json = json.dumps(current.get("categories", {}), indent=2)
        truncated = user_message[:500] + "..." if len(user_message) > 500 else user_message

        system_prompt = f"""You extract personal info about the user from their messages.

CRITICAL RULE: Only extract information that the USER explicitly states about themselves.
NEVER extract information from the AI assistant's responses — only the user's own words matter.

EXTRACT when the user shares:
- Their name, age, gender, location, job, hobbies, skills, goals, preferences
- Projects they work on, languages they use, tools they like
- Personal facts, opinions about tech, things they enjoy
- Corrections or updates to info they shared before

DO NOT EXTRACT:
- Random facts, general knowledge questions, one-off jokes
- Code snippets that aren't about the user's own projects
- Information the AI assistant mentioned — only trust the USER's statements

EXAMPLES:
User: "My name is Filip" -> {{ "changes": {{ "Person": {{ "name": "Filip" }} }} }}
User: "I'm 17 years old" -> {{ "changes": {{ "Person": {{ "age": "17" }} }} }}
User: "I work on a Unity game" -> {{ "changes": {{ "Projects": {{ "game_dev": "Working on a Unity game" }} }} }}

Current memory: {memory_json}

User message: "{truncated}"

Respond with JSON: {{ "changes": {{ "Category": {{ "key": "value" }} }} }}
Use categories like Person, Projects, Hobbies, Work, Preferences, Skills.
Add new categories if needed. Update values when the user corrects them.
If nothing to extract, respond with {{ "changes": {{}} }}
ONLY output the JSON object. No other text."""

        resolved = await get_resolved_model("extraction")
        extractor_model = resolved["model"]
        cloud = await get_cloud_settings() if resolved["source"] == "cloud" else {"cloudEndpoint": "", "cloudApiKey": ""}
        log_info(f"[extractor] Model: {extractor_model} (source: {resolved['source']})")

        chunks: list[str] = []
        try:
            await stream_chat(
                extractor_model,
                [{"role": "system", "content": system_prompt}],
                lambda chunk: chunks.append(chunk),
                StreamOptions(
                    think=False,
                    base_url=cloud.get("cloudEndpoint") or None,
                    api_key=cloud.get("cloudApiKey") or None,
                ),
            )
        except Exception as e:  # noqa: BLE001
            log_error("[extractor] Extraction call failed:", e)
            return

        raw_output = "".join(chunks)
        # <think> blocks from thinking models would break the regex below
        # (they contain braces) — strip them first.
        raw_output = re.sub(r"<[?]?[\w-]*think[\w-]*>[\s\S]*?</[?]?[\w-]*think[\w-]*>", "", raw_output, flags=re.IGNORECASE)
        m = re.search(r"\{[\s\S]*\}", raw_output)
        if not m:
            log_info("[extractor] No JSON found in extraction output")
            return
        # json.JSONDecodeError "Extra data: line 3 column 1" happened when the
        # model emitted several JSON objects / trailing text — greedy match
        # grabbed past the first object. Walk the string with a decoder to
        # take the FIRST complete JSON object.
        decoder = json.JSONDecoder()
        result = None
        for idx, ch in enumerate(m.group(0)):
            if ch != "{":
                continue
            try:
                result, _ = decoder.raw_decode(m.group(0)[idx:])
                break
            except json.JSONDecodeError:
                continue
        if result is None:
            log_error("[extractor] Failed to parse extraction JSON: no complete JSON object")
            return

        changes = result.get("changes")
        if not changes or not changes.keys():
            log_info("[extractor] No changes to memory")
            return

        log_info("[extractor] Memory changes detected:", json.dumps(changes))
        await merge_memory_entries(user_id, changes)
        log_info("[extractor] Memory updated successfully")
    except Exception as e:  # noqa: BLE001
        log_error("[extractor] Extraction failed:", e)
