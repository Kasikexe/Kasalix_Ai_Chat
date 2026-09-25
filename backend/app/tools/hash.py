"""Hash Tool — mirrors backend/src/services/tools/hash.ts."""

from __future__ import annotations

import hashlib
import hmac as hmac_lib
import re
from typing import Any

from ..logger import info as log_info
from . import ToolContext, ToolDefinition, ToolParam, ToolResult, register_tool

HASH_ALGORITHMS = ["md5", "sha1", "sha256", "sha512", "sha3-256", "sha3-512", "blake2b", "blake2s"]


def generate_hash(text: str, algorithm: str) -> str:
    h = hashlib.new(algorithm.replace("-", "_"))
    h.update(text.encode("utf-8"))
    return h.hexdigest()


def generate_hmac(text: str, key: str, algorithm: str) -> str:
    return hmac_lib.new(key.encode("utf-8"), text.encode("utf-8"), algorithm.replace("-", "_")).hexdigest()


DEFINITION = ToolDefinition(
    id="hash",
    name="Hash Generator",
    description="Generate cryptographic hashes: MD5, SHA1, SHA256, SHA512, SHA3, HMAC. Also verify hashes.",
    version="1.0.0",
    icon="\U0001f512",
    params=[
        ToolParam(name="action", type="string", description="Action: hash, hmac, all, verify", required=True),
        ToolParam(name="text", type="string", description="Text to hash", required=True),
        ToolParam(name="algorithm", type="string", description="Hash algorithm: md5, sha1, sha256, sha512, sha3-256, blake2b (default: sha256)", required=False),
        ToolParam(name="key", type="string", description="Secret key (for HMAC)", required=False),
        ToolParam(name="hash", type="string", description="Expected hash (for verification)", required=False),
    ],
)


async def execute(params: dict[str, Any], ctx: ToolContext) -> ToolResult:
    text = str(params.get("text") or params.get("query") or ctx.userInput or "")
    action = str(params.get("action") or "hash").lower()
    algorithm = str(params.get("algorithm") or "sha256").lower()
    key = str(params.get("key") or "")
    expected_hash = str(params.get("hash") or "").lower()

    if not text.strip():
        return ToolResult(success=False, output="Please provide text to hash.")

    if action in ("hash", "generate", "digest"):
        if algorithm not in HASH_ALGORITHMS:
            return ToolResult(
                success=False,
                output=f'Unsupported algorithm "{algorithm}". Available: {", ".join(HASH_ALGORITHMS)}',
            )
        digest = generate_hash(text, algorithm)
        return ToolResult(success=True, output=f"{algorithm.upper()}: {digest}", data={"algorithm": algorithm, "hash": digest, "input": text})

    if action in ("hmac", "mac"):
        if not key:
            return ToolResult(success=False, output="An HMAC key is required for HMAC generation.")
        if algorithm not in HASH_ALGORITHMS:
            return ToolResult(
                success=False,
                output=f'Unsupported algorithm "{algorithm}". Available: {", ".join(HASH_ALGORITHMS)}',
            )
        mac = generate_hmac(text, key, algorithm)
        return ToolResult(success=True, output=f"HMAC-{algorithm.upper()}: {mac}", data={"algorithm": f"hmac-{algorithm}", "hash": mac})

    if action in ("all", "full"):
        results = {
            "md5": generate_hash(text, "md5"),
            "sha1": generate_hash(text, "sha1"),
            "sha256": generate_hash(text, "sha256"),
            "sha512": generate_hash(text, "sha512"),
        }
        preview = text[:50] + ("..." if len(text) > 50 else "")
        return ToolResult(
            success=True,
            output=(
                f'All hashes for "{preview}":\n\u2022 MD5:    {results["md5"]}\n\u2022 SHA1:   {results["sha1"]}'
                f"\n\u2022 SHA256: {results['sha256']}\n\u2022 SHA512: {results['sha512']}"
            ),
            data=results,
        )

    if action in ("verify", "check", "compare"):
        if not expected_hash:
            return ToolResult(success=False, output="Please provide a hash to verify against.")
        computed = generate_hash(text, algorithm)
        match = hmac_lib.compare_digest(computed, expected_hash)
        output = (
            f"\u2705 Hash matches! {algorithm.upper()}: {computed}"
            if match
            else f"\u274c Hash does NOT match.\nExpected: {expected_hash}\nComputed: {computed}"
        )
        return ToolResult(success=True, output=output, data={"match": match, "expected": expected_hash, "computed": computed, "algorithm": algorithm})

    return ToolResult(success=False, output=f'Unknown action "{action}". Available: hash, hmac, all, verify')


def detect(input_text: str) -> dict[str, Any] | None:
    lower = input_text.lower()
    hash_keywords = ["md5", "sha1", "sha256", "sha512", "sha3", "blake2", "hash", "hmac"]
    has_keyword = any(kw in lower for kw in hash_keywords)
    wants_hash = bool(re.search(r"generate\s+(a\s+)?hash|create\s+(a\s+)?hash|hash\s+(this|the|of)|compute\s+(a\s+)?hash", lower, re.IGNORECASE))
    wants_verify = bool(re.search(r"(verify|check|compare)\s+(a\s+)?hash|hash\s+(match|verify|check)|does.*match", lower, re.IGNORECASE))

    if wants_hash:
        return {"confidence": 0.8, "params": {"action": "all", "query": input_text}}
    if wants_verify:
        return {"confidence": 0.7, "params": {"action": "verify", "query": input_text}}
    if has_keyword and any(k in lower for k in ("hash", "generate", "compute", "create")):
        return {"confidence": 0.6, "params": {"action": "all", "query": input_text}}
    return None


def register_hash_tool() -> None:
    register_tool(DEFINITION, execute)
    log_info("[tools] Hash Generator registered")
