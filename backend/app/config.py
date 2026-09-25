"""Global configuration — mirrors backend/src/utils/helpers.ts.

Persistent user data (accounts, conversations, speed tests, memory, uploads,
settings) lives in DATA_DIR so runtime data survives updates, exactly like the
TS backend. The Server App passes DATA_DIR; plain `uv run app.main` keeps it
under backend/data.
"""

import os
import uuid
from pathlib import Path


def get_data_dir() -> Path:
    return Path(os.environ.get("DATA_DIR") or (Path.cwd() / "data"))


def get_generated_images_dir() -> Path:
    """Files produced by the AI draw_image tool. GENERATED_IMAGES_DIR override
    matches the TS backend (the Electron launcher sets it so images persist
    next to the exe)."""
    env = os.environ.get("GENERATED_IMAGES_DIR")
    if env:
        return Path(env)
    return Path.cwd() / "generated_images"


def get_attachments_dir() -> Path:
    """Images attached to chat messages (content-addressed). Unlike generated
    artwork this is user data, so it lives in DATA_DIR and survives updates."""
    env = os.environ.get("ATTACHMENTS_DIR")
    if env:
        return Path(env)
    return get_data_dir() / "attachments"


def get_release_dir() -> Path:
    return Path.cwd().parent / "release"


def get_static_dir() -> Path:
    """Built frontend files served when the backend runs standalone."""
    return Path.cwd().parent / "frontend" / "dist"


def get_certs_dir() -> Path:
    return Path.cwd().parent / "certs"


def generate_id() -> str:
    return str(uuid.uuid4())


def truncate(text: str, max_len: int) -> str:
    if len(text) <= max_len:
        return text
    return text[:max_len].strip() + "..."


def port() -> int:
    return int(os.environ.get("PORT") or 3001)


def ollama_base_url() -> str:
    return os.environ.get("OLLAMA_URL") or "http://localhost:11434"


def github_repo() -> str:
    return os.environ.get("GITHUB_REPO") or "Kasikexe/Kasalix"


def github_releases_url() -> str:
    env = os.environ.get("GITHUB_RELEASES_URL")
    if env:
        return env
    return f"https://github.com/{github_repo()}/releases"


def app_version() -> str:
    return os.environ.get("APP_VERSION") or "0.11.0"
