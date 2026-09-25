"""App-level safety net — mirrors backend/src/services/content-guard.ts.

Blocks genuinely illegal or dangerous requests BEFORE they reach the model.
Intentionally conservative: a message is only blocked when it pairs an INTENT
with a DANGEROUS TOPIC. Innocent mentions pass through untouched.
"""

from __future__ import annotations

import re
from typing import Any

# Topic side: the dangerous thing being asked about.
TOPIC_PATTERNS = [
    re.compile(r"\b(pipe bomb|pressure[- ]cooker bomb|fertilizer bomb|improvised explosive\b|ied\b|explosive device|detonator|napalm|thermite|gunpowder|dynamite|c[47]\b|plastic explosive|incendiary device)\b", re.IGNORECASE),
    re.compile(r"\b(bomb|bombs|explosive|explosives)\b", re.IGNORECASE),
    re.compile(r"\b(meth|methamphetamine|crystal meth|meth lab)\b", re.IGNORECASE),
    re.compile(r"\b(synthesiz(?:e|ing) (?:drugs?|mdma|lsd|ecstasy|heroin|fentanyl|meth))\b", re.IGNORECASE),
    re.compile(r"\b(ricin|sarin|nerve agent|anthrax|cyanide)\b", re.IGNORECASE),
    re.compile(r"\b(doxx?(?:ing|ed)?|swatting)\b", re.IGNORECASE),
    re.compile(r"\b(identity theft|credit card fraud|carding|counterfeit (?:money|bills|currency)|forg(?:e|ing) (?:a |an |the )?(?:passports?|documents?|ids?))\b", re.IGNORECASE),
    re.compile(r"\b(gun|firearm|pistol|rifle|shotgun|silencer|suppressor)\b", re.IGNORECASE),
]

# Intent side: the user actually asking to make/do it, not discussing it.
INTENT_PATTERNS = [
    re.compile(r"\bhow (to|do i|can i|would i)\b", re.IGNORECASE),
    re.compile(r"\b(make|build|create|construct|produce|manufacture|assemble|prepare|synthesize|forge|craft)\b", re.IGNORECASE),
    re.compile(r"\b(recipe|instructions?|steps?|step[- ]by[- ]step|tutorial|guide)\b", re.IGNORECASE),
    re.compile(r"\bwant(s|ed)? to (make|build|create|construct|produce|manufacture|synthesize|forge)\b", re.IGNORECASE),
]

# Whole phrases that are dangerous on their own — no intent word needed.
DIRECT_PHRASES = [
    re.compile(r"\b(pipe bomb recipe|meth recipe|meth lab setup|synthesize meth|make meth|build a bomb|make a bomb|build a pipe bomb|make a pipe bomb)\b", re.IGNORECASE),
]


def find_dangerous_request(messages: list[dict[str, Any]]) -> str | None:
    """Short human description of the first dangerous request found, or None."""
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    if last_user is None:
        return None
    text = last_user.get("content", "")

    for p in DIRECT_PHRASES:
        if p.search(text):
            return p.pattern

    if not any(p.search(text) for p in INTENT_PATTERNS):
        return None
    for p in TOPIC_PATTERNS:
        if p.search(text):
            return p.pattern
    return None


DANGEROUS_REPLY = (
    "Ah, that one I'm not going to help with — no instructions for bombs, weapons, "
    "drugs, or fraud. Ask me about almost anything else though."
)
