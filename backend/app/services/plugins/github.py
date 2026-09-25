"""Plugin Platform — GitHub fetcher (mirrors backend/src/services/plugins/github.ts).

Downloads a plugin from a GitHub repository using the public API:
  1. Resolve the default branch
  2. Fetch the recursive file tree
  3. Download each file's content (raw.githubusercontent.com)
This needs no auth token and works for public repos.
"""

from __future__ import annotations

import re
import urllib.parse
from typing import Any

import httpx

from ...logger import error as log_error, warn as log_warn

GITHUB_API = "https://api.github.com"
RAW_BASE = "https://raw.githubusercontent.com"
USER_AGENT = "Kasalix-Server/1.0"

_GITHUB_CLIENT: httpx.AsyncClient | None = None


def _client() -> httpx.AsyncClient:
    global _GITHUB_CLIENT
    if _GITHUB_CLIENT is None:
        _GITHUB_CLIENT = httpx.AsyncClient(
            timeout=20,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
    return _GITHUB_CLIENT


def parse_repo_input(input: str) -> dict[str, str]:
    """Normalize 'owner/repo', 'owner/repo/subdir', or a full GitHub URL."""
    s = input.strip()
    if not s:
        raise ValueError("Repository is required")
    url_match = re.match(
        r"^https?://github\.com/([^\s/]+)/([^\s#?]+)(?:/(?:tree|blob)/[^\s/]+)?(?:/([^#?\s]*))?",
        s,
        re.I,
    )
    if url_match:
        parts = [url_match.group(1), url_match.group(2)]
        if url_match.group(3):
            parts.extend(p for p in url_match.group(3).split("/") if p)
    else:
        parts = [p for p in s.split("/") if p]
    if len(parts) < 2:
        raise ValueError('Invalid repository. Use "owner/repo" or a GitHub URL.')
    owner = re.sub(r"[^\w.-]", "", parts[0])
    repo = re.sub(r"[^\w.-]", "", parts[1])
    if not owner or not repo:
        raise ValueError("Invalid repository name")
    path = "/".join(parts[2:]) if len(parts) > 2 else ""
    return {"owner": owner, "repo": repo, "path": path or ""}


async def _github_json(url: str) -> Any:
    client = _client()
    res = await client.get(url)
    if res.status_code in (403, 429):
        raise RuntimeError("GitHub API rate limit reached. Try again in a few minutes.")
    if res.status_code >= 400:
        raise RuntimeError(f"GitHub API error {res.status_code} for {url}")
    return res.json()


async def resolve_repo(spec: dict[str, str]) -> str:
    """Resolve the repo's default branch and validate it exists."""
    info = await _github_json(f"{GITHUB_API}/repos/{spec['owner']}/{spec['repo']}")
    branch = info.get("default_branch") or "main"
    if not isinstance(branch, str) or not branch:
        raise RuntimeError("Could not determine the repository default branch")
    return branch


async def get_repo_files(owner: str, repo: str, branch: str, subdir: str | None = None) -> list[str]:
    """Get every file path in the repo (optionally under a subdirectory)."""
    tree = await _github_json(
        f"{GITHUB_API}/repos/{owner}/{repo}/git/trees/{urllib.parse.quote(branch)}?recursive=1"
    )
    entries = tree.get("tree") or []
    prefix = (subdir or "").strip("/") + "/" if subdir else ""
    result: list[str] = []
    for e in entries:
        if e.get("type") != "blob" or not e.get("path"):
            continue
        p: str = e["path"]
        if prefix and not p.startswith(prefix):
            continue
        rel = p[len(prefix):] if prefix else p
        if rel == ".git" or rel.startswith(".git/") or rel.startswith("node_modules/") or "/node_modules/" in rel:
            continue
        result.append(p)
    return result


async def download_raw_file(owner: str, repo: str, branch: str, path_in_repo: str) -> str | None:
    """Download a single file's text content. Returns None if not found."""
    encoded_path = "/".join(urllib.parse.quote(seg) for seg in path_in_repo.split("/"))
    url = f"{RAW_BASE}/{owner}/{repo}/{urllib.parse.quote(branch)}/{encoded_path}"
    client = httpx.AsyncClient(timeout=20, headers={"User-Agent": USER_AGENT})
    try:
        res = await client.get(url)
    finally:
        await client.aclose()
    if res.status_code == 404:
        return None
    if res.status_code >= 400:
        raise RuntimeError(f"Failed to download {path_in_repo} (HTTP {res.status_code})")
    text = res.text
    if len(text) > 5 * 1024 * 1024:
        raise RuntimeError(f"File too large: {path_in_repo} (over 5 MB)")
    return text


async def fetch_repo_tree(spec: dict[str, Any]) -> list[str]:
    return await get_repo_files(spec["owner"], spec["repo"], spec["branch"], spec.get("path") or None)