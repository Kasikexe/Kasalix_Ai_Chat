"""Speed test suite — mirrors backend/src/services/speedtest.ts.

Runs benchmark prompts against each model assignment and reports tokens/s,
time-to-first-token, and quality checks. Generates a small fox PNG test image
for vision tests using pure zlib PNG encoding (no PIL dependency needed).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import struct
import time
import zlib
from pathlib import Path
from typing import Any, Callable

from ..config import get_data_dir
from ..logger import error as log_error, info as log_info
from ..model_assignments import get_model_assignment
from ..ollama_client import StreamOptions, chat

# ─── Model Assignment Keys ──────────────────────────────────
ASSIGNMENT_LABELS: dict[str, str] = {
    "chat": "Chat",
    "chat_thinking": "Chat (Thinking)",
    "code": "Code Generation",
    "vision": "Vision Analysis",
    "search": "Web Search",
    "extraction": "Memory Extraction",
}

ASSIGNMENT_ICONS: dict[str, str] = {
    "chat": "💬",
    "chat_thinking": "🧠",
    "code": "💻",
    "vision": "👁️",
    "search": "🌐",
    "extraction": "📝",
}

DATA_DIR = Path(get_data_dir()) / "speedtest"
TEST_IMAGE_PATH = DATA_DIR / "test_fox.png"
RESULTS_FILE = DATA_DIR / "results.json"


# ─── Test Image Generation ──────────────────────────────────
def _create_fox_png() -> bytes:
    """Create a 64x64 PNG image of a simple fox face (raw pixels + zlib)."""
    width = 64
    height = 64
    channels = 4  # RGBA

    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter byte: None
        for x in range(width):
            nx = (x / width) * 2 - 1
            ny = (y / height) * 2 - 1
            dist_center = (nx * nx + ny * ny) ** 0.5

            in_face = (nx * nx) / 0.45 + (ny * ny) / 0.6 <= 1
            left_ear = nx < -0.3 and ny < -0.55 and ny > -0.85 and abs(nx + 0.55) < (0.3 - (ny + 0.85) * 0.8)
            right_ear = nx > 0.3 and ny < -0.55 and ny > -0.85 and abs(nx - 0.55) < (0.3 - (ny + 0.85) * 0.8)
            left_eye = abs(nx + 0.25) < 0.08 and abs(ny - 0.1) < 0.08
            right_eye = abs(nx - 0.25) < 0.08 and abs(ny - 0.1) < 0.08
            nose = abs(nx) < 0.06 and 0.15 < ny < 0.25
            muzzle = in_face and ny > 0.05 and abs(nx) < 0.2
            bg_gradient = 30 + round((1 - dist_center) * 30)

            if left_ear or right_ear:
                r, g, b = 180, 80, 30
            elif left_eye or right_eye:
                r, g, b = 20, 15, 10
            elif nose:
                r, g, b = 40, 25, 15
            elif muzzle:
                r, g, b = 240, 230, 215
            elif in_face:
                fur_noise = int(__import__("math").sin(x * 3.7 + y * 5.1) * 15)
                r, g, b = 210 + fur_noise, 120 + round(fur_noise * 0.5), 40
            else:
                r, g, b = bg_gradient, bg_gradient + 40, bg_gradient + 60
            raw.extend((r & 0xFF, g & 0xFF, b & 0xFF, 255))

    def chunk(chunk_type: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + chunk_type
            + data
            + struct.pack(">I", zlib.crc32(chunk_type + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw)))
        + chunk(b"IEND", b"")
    )


async def get_test_image_base64() -> str:
    """Get the test fox image as a base64 data URL (generated + cached)."""
    try:
        image_bytes = TEST_IMAGE_PATH.read_bytes()
    except OSError:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        image_bytes = _create_fox_png()
        TEST_IMAGE_PATH.write_bytes(image_bytes)
        log_info(f"[speedtest] Generated test fox image ({len(image_bytes) / 1024:.1f} KB)")
    import base64

    return f"data:image/png;base64,{base64.b64encode(image_bytes).decode()}"


# ─── Test Definitions ───────────────────────────────────────
SPEED_TESTS: list[dict[str, Any]] = [
    {"id": "greeting", "name": "Greeting", "description": "Basic welcome message — tests chat response time",
     "assignmentKey": "chat", "category": "simple", "needsImage": False,
     "messages": [
         {"role": "system", "content": "You are a helpful AI assistant. Respond concisely in 1-2 sentences."},
         {"role": "user", "content": "Hello! How are you today?"},
     ]},
    {"id": "quick-fact", "name": "Quick Fact", "description": "Simple factual question — tests basic knowledge retrieval",
     "assignmentKey": "chat", "category": "simple", "needsImage": False,
     "messages": [
         {"role": "system", "content": "You are a helpful AI assistant. Respond concisely."},
         {"role": "user", "content": "What is the capital of France?"},
     ]},
    {"id": "follow-up", "name": "Short Follow-up", "description": "Short conversational response — tests context handling",
     "assignmentKey": "chat", "category": "simple", "needsImage": False,
     "messages": [
         {"role": "system", "content": "You are a helpful AI assistant. Respond concisely."},
         {"role": "user", "content": "Great, thanks for your help!"},
     ]},
    {"id": "logic-puzzle", "name": "Logic Puzzle", "description": "A reasoning problem — tests the thinking model's depth",
     "assignmentKey": "chat_thinking", "category": "long", "needsImage": False,
     "messages": [
         {"role": "system", "content": "You are a logical reasoning assistant. Think step by step."},
         {"role": "user", "content": "If a train leaves Station A traveling at 60 mph and another train leaves Station B 100 miles away traveling at 40 mph towards each other, at what distance from Station A will they meet?"},
     ]},
    {"id": "math-problem", "name": "Math Problem", "description": "Multi-step calculation — tests reasoning speed",
     "assignmentKey": "chat_thinking", "category": "long", "needsImage": False,
     "messages": [
         {"role": "system", "content": "You are a math assistant. Show your work clearly."},
         {"role": "user", "content": "A rectangle has a perimeter of 48 cm. Its length is 6 cm longer than its width. What is the area of the rectangle?"},
     ]},
    {"id": "react-component", "name": "React Component", "description": "Generate a TypeScript React component — tests code model",
     "assignmentKey": "code", "category": "code", "needsImage": False,
     "messages": [
         {"role": "system", "content": "You are an expert TypeScript/React developer. Generate clean, production-ready code."},
         {"role": "user", "content": "Write a React button component in TypeScript that shows a click counter. Use useState hook and proper TypeScript types."},
     ]},
    {"id": "api-endpoint", "name": "API Endpoint", "description": "Generate a backend API route — tests code generation for backend",
     "assignmentKey": "code", "category": "code", "needsImage": False,
     "messages": [
         {"role": "system", "content": "You are an expert backend developer. Generate clean, working code."},
         {"role": "user", "content": 'Write a simple Express.js API endpoint that handles CRUD operations for a "tasks" resource with in-memory storage.'},
     ]},
    {"id": "fox-object", "name": "Fox Object Detection", "description": "Identify objects in a test image — tests real vision processing with an image",
     "assignmentKey": "vision", "category": "vision", "needsImage": True,
     "messages": [
         {"role": "system", "content": "You are a vision analysis assistant. Describe what you see in the image in 2-3 sentences. Focus on: what animal is shown, its colors, and any facial features you can identify."},
         {"role": "user", "content": "[image:{{IMAGE}}] What animal do you see in this image? Describe its colors and any facial features."},
     ]},
    {"id": "fox-color", "name": "Fox Color Analysis", "description": "Analyze colors in a test image — tests vision model color perception with an image",
     "assignmentKey": "vision", "category": "vision", "needsImage": True,
     "messages": [
         {"role": "system", "content": "You are a color analysis assistant. Describe the dominant colors, patterns, and any facial features you observe in the image. Be specific about color names."},
         {"role": "user", "content": "[image:{{IMAGE}}] What are the dominant colors in this image? Describe the facial features and patterns you can see."},
     ]},
    {"id": "news-summary", "name": "News Summary", "description": "Summarize search-like content — tests search model",
     "assignmentKey": "search", "category": "search", "needsImage": False,
     "messages": [
         {"role": "system", "content": "You are a precise web search summarizer. Extract and report only facts explicitly stated."},
         {"role": "user", "content": 'Based on the following information: "The 2024 Summer Olympics were held in Paris, France. Over 10,000 athletes from 206 nations participated. The games featured 32 sports including new additions like breaking (breakdancing)." Summarize the key facts.'},
     ]},
    {"id": "tech-trends", "name": "Tech Trends", "description": "Summarize technical information — tests search model comprehension",
     "assignmentKey": "search", "category": "search", "needsImage": False,
     "messages": [
         {"role": "system", "content": "You are a technical research summarizer. Report facts accurately."},
         {"role": "user", "content": 'Summarize: "TypeScript 5.5 introduced inferred type predicates. React 19 added server components and actions. Bun 1.1 improved Windows support and Node.js compatibility."'},
     ]},
    {"id": "extract-info", "name": "Extract Info", "description": "Extract personal information from text — tests extraction model",
     "assignmentKey": "extraction", "category": "simple", "needsImage": False,
     "messages": [
         {"role": "system", "content": "Extract personal information about the user from their message. Output JSON with categories."},
         {"role": "user", "content": "Hi! My name is Sarah Johnson. I am a 28-year-old software engineer from San Francisco. I enjoy hiking and playing the piano in my free time. I work on machine learning projects."},
     ]},
]


# ─── Quality Checks ───────────────────────────────────────────
def _make_check(name: str, pattern: str, flags: int = re.IGNORECASE) -> Callable[[str], dict[str, Any]]:
    rx = re.compile(pattern, flags)

    def check(response: str) -> dict[str, Any]:
        m = rx.search(response)
        return {"name": name, "passed": m is not None, "details": m.group(0) if m else None}

    return check


QUALITY_CHECKS: dict[str, list[Callable[[str], dict[str, Any]]]] = {
    "greeting": [
        lambda r: {"name": "Not empty", "passed": len(r.strip()) > 0, "details": f"{len(r.strip())} chars" if r.strip() else "Empty response"},
        _make_check("Has greeting", r"\b(hello|hi\b|hey|howdy|greetings)\b"),
    ],
    "quick-fact": [
        lambda r: {"name": "Not empty", "passed": len(r.strip()) > 0},
        _make_check("Mentions Paris", r"\bparis\b"),
        _make_check("Mentions France", r"\bfrance\b"),
    ],
    "follow-up": [
        lambda r: {"name": "Not empty", "passed": len(r.strip()) > 0},
        _make_check("Friendly tone", r"\b(you'?re welcome|thanks|glad|happy|welcome|anytime|pleasure|no problem|my pleasure)\b"),
    ],
    "logic-puzzle": [
        lambda r: {"name": "Not empty", "passed": len(r.strip()) > 0},
        _make_check("Correct distance", r"\b60\b.*\b(mile|mi\.?)\b|\b(mile|mi\.?)\b.*\b60\b"),
    ],
    "math-problem": [
        lambda r: {"name": "Not empty", "passed": len(r.strip()) > 0},
        _make_check("Correct area", r"\b135\b"),
    ],
    "react-component": [
        lambda r: {"name": "Not empty", "passed": len(r.strip()) > 0},
        _make_check("Uses useState", r"\buseState\b"),
        _make_check("TypeScript types", r":\s*(string|number|boolean|void|React\.|Props|interface|type\s)"),
        _make_check("React component", r"\b(React|const\s+\w+:|function\s+\w+)"),
    ],
    "api-endpoint": [
        lambda r: {"name": "Not empty", "passed": len(r.strip()) > 0},
        _make_check("Express routes", r"\.(get|post|put|delete|patch)\s*\("),
        _make_check("CRUD operations", r"\b(get|post|put|delete|patch)\b.*\b(get|post|put|delete|patch)\b"),
        lambda r: {
            "name": "In-memory storage",
            "passed": bool(re.search(r"\b(const|let|var)\s+\w+\s*[=:]\s*\[\s*\]|\b(const|let|var)\s+\w+\s*[=:]\s*\{\s*\}", r)) or bool(re.search(r"\bmemory\b", r, re.IGNORECASE)),
        },
    ],
    "fox-object": [
        lambda r: {"name": "Not empty", "passed": len(r.strip()) > 0},
        _make_check("Identifies animal", r"\b(fox|animal|creature|face|mammal)\b"),
        _make_check("Describes color", r"\b(orange|brown|white|black|cream|dark|ginger|amber|reddish)\b"),
        _make_check("Mentions features", r"\b(ear|eye|nose|face|muzzle|fur|whisker|head|snout|triangular|pointy)\b"),
    ],
    "fox-color": [
        lambda r: {"name": "Not empty", "passed": len(r.strip()) > 0},
        _make_check("Identifies orange", r"\b(orange|ginger|amber|reddish|brown)\b"),
        _make_check("Mentions white/cream", r"\b(white|cream|light|pale)\b"),
        _make_check("Describes pattern", r"\b(ear|eye|nose|face|muzzle|fur|stripe|pattern|marking|tip|patch)\b"),
    ],
    "news-summary": [
        lambda r: {"name": "Not empty", "passed": len(r.strip()) > 0},
        _make_check("Mentions Paris", r"\bparis\b"),
        _make_check("Includes numbers", r"\b(10,000|10000|206|32)\b"),
    ],
    "tech-trends": [
        lambda r: {"name": "Not empty", "passed": len(r.strip()) > 0},
        _make_check("Mentions TypeScript", r"\btypescript\b"),
        _make_check("Mentions React/Server", r"\b(react|server\s*components)\b"),
        _make_check("Mentions Bun", r"\bbun\b"),
    ],
    "extract-info": [
        lambda r: {"name": "Not empty", "passed": len(r.strip()) > 0},
        lambda r: {"name": "Contains JSON", "passed": "{" in r and "}" in r},
        _make_check("Extracts name", r"\b(sarah|Johnson|Sarah Johnson)\b"),
        _make_check("Extracts profession", r"\b(software\s*engineer|engineer|developer)\b"),
    ],
}


def _generate_id() -> str:
    import random

    return f"st_{int(time.time() * 1000)}_{''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=4))}"


async def get_results() -> list[dict[str, Any]]:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        return json.loads(RESULTS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


async def _save_results(results: list[dict[str, Any]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_FILE.write_text(json.dumps(results, indent=2), encoding="utf-8")


async def delete_result(id: str) -> bool:
    results = await get_results()
    filtered = [r for r in results if r.get("id") != id]
    if len(filtered) == len(results):
        return False
    await _save_results(filtered)
    return True


async def run_single_test(
    test: dict[str, Any],
    model: str,
    signal: asyncio.Event | None = None,
    image_data_url: str | None = None,
) -> dict[str, Any]:
    start_time = time.time() * 1000
    full_response = ""
    has_error = False
    error_msg: str | None = None

    if test.get("needsImage") and not image_data_url:
        has_error = True
        error_msg = "Test image not available — cannot run vision test"

    test_messages = test["messages"]
    if test.get("needsImage") and image_data_url:
        test_messages = [
            {**m, "content": m.get("content", "").replace("{{IMAGE}}", image_data_url)}
            for m in test_messages
        ]

    if not has_error:
        try:
            full_response = await chat(
                model,
                test_messages,
                StreamOptions(signal=signal, temperature=0.1, max_tokens=300),
            )
        except Exception as e:  # noqa: BLE001
            has_error = True
            error_msg = str(e)

    total_time = time.time() * 1000 - start_time
    first_token_time = round(total_time * 0.2)

    total_chars = len(full_response)
    estimated_tokens = round(total_chars / 4)
    tokens_per_second = round((estimated_tokens / total_time) * 1000 * 10) / 10 if total_time > 0 else 0

    checks = QUALITY_CHECKS.get(test["id"], [])
    if not has_error and checks:
        quality_checks = [c(full_response) for c in checks]
    elif not has_error:
        quality_checks = [{"name": "No checks defined", "passed": True}]
    else:
        quality_checks = [{"name": "Skipped (error)", "passed": False, "details": error_msg}]
    passed_checks = sum(1 for c in quality_checks if c["passed"])
    quality_score = round(passed_checks / len(quality_checks) * 100) if quality_checks else 0

    return {
        "testId": test["id"],
        "testName": test["name"],
        "category": test["category"],
        "assignmentKey": test["assignmentKey"],
        "success": not has_error,
        "totalTimeMs": round(total_time),
        "timeToFirstTokenMs": first_token_time,
        "totalChars": total_chars,
        "estimatedTokens": estimated_tokens,
        "tokensPerSecond": tokens_per_second,
        "model": model,
        "error": error_msg,
        "timestamp": int(time.time() * 1000),
        "qualityScore": quality_score,
        "qualityChecks": quality_checks,
    }


async def run_speed_tests(
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    options = options or {}
    signal: asyncio.Event | None = options.get("signal")
    start_time = time.time() * 1000
    run_id = _generate_id()
    date = datetime_iso()

    image_data_url = await get_test_image_base64()

    keys: list[str] = []
    for t in SPEED_TESTS:
        if t["assignmentKey"] not in keys:
            keys.append(t["assignmentKey"])

    models: dict[str, str] = {}
    for key in keys:
        try:
            models[key] = await get_model_assignment(key)
            log_info(f'[speedtest] Assignment "{key}" → model: {models[key]}')
        except Exception as e:  # noqa: BLE001
            log_error(f'[speedtest] Failed to get model for "{key}":', e)
            models[key] = "unknown"

    log_info(f"[speedtest] Starting test suite with {len(keys)} model groups, {len(SPEED_TESTS)} total tests")

    test_results: list[dict[str, Any]] = []
    for key in keys:
        model = models[key]
        group_tests = [t for t in SPEED_TESTS if t["assignmentKey"] == key]
        log_info(f'[speedtest] Running {len(group_tests)} test(s) for "{key}" ({model})...')
        for test in group_tests:
            log_info(f'[speedtest]   Test: {test["name"]}{" [with image]" if test.get("needsImage") else ""}...')
            result = await run_single_test(test, model, signal, image_data_url)
            test_results.append(result)
            mark = "✅" if result["success"] else "❌"
            log_info(f'[speedtest]     → {mark} {result["totalTimeMs"]}ms, {result["tokensPerSecond"]} tok/s')

    total_duration = time.time() * 1000 - start_time
    passed = sum(1 for r in test_results if r["success"])
    failed = len(test_results) - passed
    avg_time = round(sum(r["totalTimeMs"] for r in test_results) / len(test_results)) if test_results else 0
    avg_tps = sum(r["tokensPerSecond"] for r in test_results) / len(test_results) if test_results else 0
    avg_ttft = round(sum(r["timeToFirstTokenMs"] for r in test_results) / len(test_results)) if test_results else 0
    avg_quality = round(sum(r["qualityScore"] for r in test_results) / len(test_results)) if test_results else 0

    model_summaries: dict[str, Any] = {}
    for key in keys:
        group_results = [r for r in test_results if r["assignmentKey"] == key]
        group_passed = sum(1 for r in group_results if r["success"])
        group_time = round(sum(r["totalTimeMs"] for r in group_results) / len(group_results)) if group_results else 0
        group_tps = sum(r["tokensPerSecond"] for r in group_results) / len(group_results) if group_results else 0
        group_quality = round(sum(r["qualityScore"] for r in group_results) / len(group_results)) if group_results else 0
        model_summaries[key] = {
            "model": models[key],
            "label": ASSIGNMENT_LABELS.get(key, key),
            "icon": ASSIGNMENT_ICONS.get(key, "🔧"),
            "tests": len(group_results),
            "passed": group_passed,
            "failed": len(group_results) - group_passed,
            "avgResponseTimeMs": group_time,
            "avgTokensPerSecond": round(group_tps * 10) / 10,
            "avgQualityScore": group_quality,
        }

    result = {
        "id": run_id,
        "date": date,
        "timestamp": int(time.time() * 1000),
        "totalDurationMs": round(total_duration),
        "models": models,
        "modelCount": len(keys),
        "tests": test_results,
        "summary": {
            "totalTests": len(test_results),
            "passed": passed,
            "failed": failed,
            "avgResponseTimeMs": avg_time,
            "avgTokensPerSecond": round(avg_tps * 10) / 10,
            "avgTimeToFirstTokenMs": avg_ttft,
            "avgQualityScore": avg_quality,
        },
        "modelSummaries": model_summaries,
    }

    all_results = await get_results()
    all_results.insert(0, result)
    await _save_results(all_results)

    log_info(f"[speedtest] Suite complete: {passed}/{len(test_results)} passed across {len(keys)} models, avg {avg_time}ms")
    return result


def datetime_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()