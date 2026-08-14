/**
 * Plugin Platform — shared types
 *
 * A plugin is a GitHub repository (or subfolder of one) that ships a
 * `plugin.json` manifest and an optional entry file that registers tools
 * with the backend at runtime. Plugins extend what the AI can do:
 * new tools, new agent capabilities, integrations (Roblox, voice, etc.).
 */

/** The `plugin.json` manifest a plugin repo must ship. */
export interface PluginManifest {
  /** Unique slug, e.g. "roblox-maker". Must match ^[a-z0-9][a-z0-9-]*$ */
  id: string;
  /** Display name, e.g. "Roblox Game Maker" */
  name: string;
  /** Semver-ish version, e.g. "1.0.0" */
  version: string;
  /** Short description shown in the UI */
  description: string;
  /** Author display name / GitHub handle */
  author?: string;
  /** Emoji icon shown in the plugin list */
  icon?: string;
  /** Minimum Kasalix app version this plugin requires (e.g. "0.9.0") */
  minKasalixVersion?: string;
  /** Relative path to the entry file that registers tools (default "index.js") */
  entry?: string;
}

/** A plugin that is installed (or being installed) on this server. */
export interface InstalledPlugin {
  /** Plugin id from the manifest (unique) */
  id: string;
  /** Parsed manifest */
  manifest: PluginManifest;
  /** Source repo in "owner/repo" form */
  repo: string;
  /** Optional subdirectory within the repo where the plugin lives */
  path?: string;
  /** Branch the plugin was fetched from (default branch) */
  branch: string;
  /** Whether the plugin's tools are active */
  enabled: boolean;
  /** When it was first installed */
  installedAt: number;
  /** When it was last updated */
  updatedAt: number;
  /** Tool ids registered by this plugin (tracked for clean uninstall) */
  toolIds: string[];
}

/** Persisted registry file shape (data/plugins/installed.json) */
export interface PluginRegistry {
  installed: InstalledPlugin[];
}
