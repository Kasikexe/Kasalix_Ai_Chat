"""Model usage map — the GUI's "Where it's used" expanders.

The map in app.model_assignments.MODEL_USAGE_DESCRIPTIONS explains where each
assigned model category is actually consumed (pipeline stages, titles, memory
extraction, search summarization, vision fallbacks). Served via
GET /api/models/usage-map. These tests pin:

- the route responds with an entry for EVERY assignment category
- every entry is a non-empty list of human-readable strings
- a route exists under the same router as /api/models (mounting verified
  by driving the real ASGI app)
"""

import os
import tempfile

import pytest
from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="kasalix-usagemap-")
os.environ["DATA_DIR"] = _TMP
os.environ["OLLAMA_URL"] = "http://127.0.0.1:9"  # unreachable — no Ollama needed

from app.main import app  # noqa: E402
from app.model_assignments import (  # noqa: E402
    ASSIGNMENT_KEYS,
    MODEL_USAGE_DESCRIPTIONS,
)


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


class TestUsageMap:
    def test_every_category_has_a_description(self):
        assert set(MODEL_USAGE_DESCRIPTIONS) == set(ASSIGNMENT_KEYS), (
            "MODEL_USAGE_DESCRIPTIONS keys drifted from ASSIGNMENT_KEYS — "
            "the GUI would silently show the stale fallback for new categories"
        )
        for key, items in MODEL_USAGE_DESCRIPTIONS.items():
            assert isinstance(items, list) and items, f"{key}: empty usage list"
            for it in items:
                assert isinstance(it, str) and it.strip(), f"{key}: blank usage entry"

    def test_route_serves_the_map(self, client):
        r = client.get("/api/models/usage-map")
        assert r.status_code == 200
        usage = r.json()["usage"]
        assert set(usage) == set(ASSIGNMENT_KEYS)
        assert usage == MODEL_USAGE_DESCRIPTIONS
