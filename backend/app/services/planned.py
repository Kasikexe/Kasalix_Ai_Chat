"""Planned features store — mirrors backend/src/services/planned.ts."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from ..config import get_data_dir

DATA_DIR = Path(get_data_dir()) / "planned"
FILE_PATH = DATA_DIR / "planned.json"


def _generate_id() -> str:
    import random

    return f"{int(time.time() * 1000):x}{''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=4))}"


def _ensure_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _get_all() -> list[dict[str, Any]]:
    try:
        return json.loads(FILE_PATH.read_text(encoding="utf-8"))
    except OSError:
        return []
    except json.JSONDecodeError:
        return []


def _save_all(features: list[dict[str, Any]]) -> None:
    _ensure_dir()
    FILE_PATH.write_text(json.dumps(features, indent=2), encoding="utf-8")


async def get_planned_features() -> list[dict[str, Any]]:
    features = _get_all()
    features.sort(key=lambda f: (f.get("order", 0), -(f.get("createdAt", 0) or 0)))
    return features


async def add_planned_feature(
    feature: dict[str, Any],
) -> dict[str, Any]:
    features = _get_all()
    new_feature: dict[str, Any] = {
        **feature,
        "id": _generate_id(),
        "order": feature.get("order", len(features)),
        "createdAt": int(time.time() * 1000),
    }
    features.append(new_feature)
    _save_all(features)
    return new_feature


async def update_planned_feature(
    id: str,
    updates: dict[str, Any],
) -> dict[str, Any] | None:
    features = _get_all()
    index = next((i for i, f in enumerate(features) if f.get("id") == id), -1)
    if index == -1:
        return None
    features[index] = {**features[index], **updates}
    _save_all(features)
    return features[index]


async def delete_planned_feature(id: str) -> bool:
    features = _get_all()
    filtered = [f for f in features if f.get("id") != id]
    if len(filtered) == len(features):
        return False
    _save_all(filtered)
    return True