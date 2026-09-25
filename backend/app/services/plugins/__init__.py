"""Plugin Platform package."""

from .catalog import (
    CATALOG_REPO,
    fetch_plugin_catalog,
    is_catalog_source,
    manifest_from_catalog_entry,
)
from .github import parse_repo_input
from .manager import (
    install_plugin,
    list_plugins,
    load_installed_plugins,
    set_plugin_enabled,
    uninstall_plugin,
    update_plugin,
)
from .types import InstalledPlugin, PluginManifest, PluginRegistry

__all__ = [
    "CATALOG_REPO",
    "InstalledPlugin",
    "PluginManifest",
    "PluginRegistry",
    "fetch_plugin_catalog",
    "install_plugin",
    "is_catalog_source",
    "list_plugins",
    "load_installed_plugins",
    "manifest_from_catalog_entry",
    "parse_repo_input",
    "set_plugin_enabled",
    "uninstall_plugin",
    "update_plugin",
]