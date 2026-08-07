/**
 * generate-licenses.mjs
 *
 * Scans every installed package in the repo's node_modules directories and
 * regenerates the THIRD_PARTY_NOTICES.md file at the repository root.
 *
 * Usage (after `bun install` / `npm install` in each sub-project):
 *   cd dev-build-tool && node generate-licenses.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROJECTS = [
  { dir: 'backend', label: 'Backend (Bun / Hono API)' },
  { dir: 'frontend', label: 'Frontend (React / Vite / Electron / Capacitor)' },
  { dir: 'server-gui', label: 'Server GUI (Electron)' },
  { dir: 'changelog-tool', label: 'Changelog tool (Node CLI)' },
  { dir: 'dev-build-tool', label: 'Dev build tool (Node)' },
];

const OUTPUT = path.join(ROOT, 'THIRD_PARTY_NOTICES.md');

/** Normalize the license field of a package.json into a display string. */
function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license || 'UNKNOWN';
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) {
    return pkg.license.type;
  }
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((l) => l.type || 'UNKNOWN').join(' OR ');
  }
  return 'UNKNOWN';
}

/** Scan one node_modules tree for installed packages. */
function scanNodeModules(projectDir) {
  const base = path.join(ROOT, projectDir, 'node_modules');
  const found = new Map();
  if (!fs.existsSync(base)) return found;
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name) {
          const key = `${pkg.name}@${pkg.version || ''}`;
          if (!found.has(key)) {
            found.set(key, { name: pkg.name, version: pkg.version, license: licenseOf(pkg) });
          }
        }
      } catch {
        /* ignore malformed package.json */
      }
    }
  };
  for (const top of fs.readdirSync(base)) {
    const topPath = path.join(base, top);
    if (!fs.statSync(topPath).isDirectory()) continue;
    if (top.startsWith('@')) {
      // Scoped packages live one level deeper
      if (fs.existsSync(topPath)) {
        for (const sub of fs.readdirSync(topPath)) {
          visit(path.join(topPath, sub));
        }
      }
    } else {
      visit(topPath);
    }
  }
  return found;
}

/** Read direct dependencies (deps + devDeps) declared in package.json. */
function readDirectDeps(projectDir) {
  const pkgPath = path.join(ROOT, projectDir, 'package.json');
  const list = [];
  if (!fs.existsSync(pkgPath)) return list;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  for (const [section, isDev] of [
    ['dependencies', false],
    ['devDependencies', true],
  ]) {
    if (!pkg[section]) continue;
    for (const name of Object.keys(pkg[section]).sort()) {
      list.push({ name, isDev });
    }
  }
  return list;
}

const all = new Map(); // key -> package info
const byProject = {}; // projectLabel -> Map of installed packages

for (const project of PROJECTS) {
  const installed = scanNodeModules(project.dir);
  byProject[project.label] = installed;
  for (const [key, info] of installed) {
    if (!all.has(key)) all.set(key, info);
  }
}

const directByName = new Map();
for (const project of PROJECTS) {
  for (const dep of readDirectDeps(project.dir)) {
    if (!directByName.has(dep.name)) directByName.set(dep.name, new Set());
    directByName.get(dep.name).add(project.label);
  }
}

// Group everything by license identifier.
const byLicense = new Map();
for (const info of all.values()) {
  if (!byLicense.has(info.license)) byLicense.set(info.license, []);
  byLicense.get(info.license).push(info);
}
const sortedLicenses = [...byLicense.keys()].sort((a, b) => {
  const rank = (l) => (l === 'UNKNOWN' ? 1 : /GPL|AGPL|LGPL/.test(l) ? 0 : 2);
  return rank(a) - rank(b) || a.localeCompare(b);
});

const date = new Date().toISOString().slice(0, 10);
const lines = [];
lines.push('# Third-Party Notices');
lines.push('');
lines.push(
  `Kasalix AI Chat incorporates third-party open-source software. This file lists the packages ` +
    `installed by the projects in this repository and their licenses.`,
);
lines.push('');
lines.push(`> Generated on ${date} by \`dev-build-tool/generate-licenses.mjs\`. Do not edit by hand — rerun the script after dependency changes.`);
lines.push('');
lines.push('## Table of contents');
lines.push('');
lines.push('- [Important notices](#important-notices)');
lines.push('- [Direct dependencies](#direct-dependencies)');
lines.push('- [Complete inventory by license](#complete-inventory-by-license)');
lines.push('- [License texts](#license-texts)');
lines.push('');
lines.push('## Important notices');
lines.push('');
lines.push(
  '- **`ffmpeg-static`** (used by the backend for video processing) bundles the FFmpeg binaries, which are ' +
    'licensed under the **GNU General Public License v3 (GPL-3.0-or-later)**. FFmpeg is invoked as a separate ' +
    'process. Its full license text is included in [`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt).',
);
lines.push(
  '- Packages below marked **UNKNOWN** do not declare a license in their `package.json`. Before redistributing ' +
    'the application, verify the intended license of each of these packages with its maintainer.',
);
lines.push(
  '- Permissive license texts (MIT, ISC, BSD, Apache-2.0, …) accompany every installed copy of these packages ' +
    'inside each project\'s `node_modules` directory.',
);
lines.push(
  '- **Distributions:** the distributed apps do **not** bundle the FFmpeg binaries. The Server GUI app downloads ' +
    'FFmpeg (the "essentials" build from https://www.gyan.dev/ffmpeg/builds/) on its first run — the same way it ' +
    'installs Bun and Ollama — and stores it in a folder next to the application. Because the binary is fetched ' +
    'directly from its provider rather than conveyed by the app, no GPL source-offer obligation applies to the ' +
    'distributed app itself. If you ever decide to bundle FFmpeg, keep a copy of ' +
    '[`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt) next to the binary and provide an offer of corresponding ' +
    'source, as required by the GPL.',
);
lines.push('');
lines.push('## Direct dependencies');
lines.push('');
lines.push(
  'The packages the projects declare directly (runtime and development). Their transitive dependencies are ' +
    'covered by the complete inventory below.',
);
lines.push('');
lines.push('| Package | Installed version | License | Used in |');
lines.push('| --- | --- | --- | --- |');
for (const project of PROJECTS) {
  const installed = byProject[project.label];
  for (const dep of readDirectDeps(project.dir)) {
    const key = [...installed.keys()].find((k) => k.startsWith(`${dep.name}@`));
    const info = key ? installed.get(key) : null;
    const version = info ? info.version : '(not installed)';
    const license = info ? info.license : '(not installed)';
    lines.push(`| \`${dep.name}\` | ${version} | ${license} | ${dep.isDev ? 'dev — ' : ''}${project.label} |`);
  }
}
lines.push('');
lines.push(`## Complete inventory by license`);
lines.push('');
lines.push(
  `${all.size} distinct package versions are installed across the repository. Inventory is grouped by ` +
    `declared license identifier.`,
);
lines.push('');
for (const license of sortedLicenses) {
  const packages = byLicense.get(license).slice().sort((a, b) => a.name.localeCompare(b.name));
  lines.push(`### ${license} (${packages.length})`);
  lines.push('');
  for (const p of packages) {
    const projects = new Set();
    for (const [label, installed] of Object.entries(byProject)) {
      if (installed.has(`${p.name}@${p.version}`)) projects.add(label);
    }
    const usedIn = projects.size ? ` — ${[...projects].join(', ')}` : '';
    lines.push(`- \`${p.name}@${p.version}\` (${p.license})${usedIn}`);
  }
  lines.push('');
}
lines.push('## License texts');
lines.push('');
lines.push(
  'The GNU GPL v3 license text (the license of the FFmpeg binaries fetched by the Server GUI on first run) is ' +
    'stored in [`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt).',
);
lines.push('');
lines.push(
  'Texts of all other licenses (Apache-2.0, MIT, BSD, ISC, etc.) are available inside each package\'s ' +
    'directory under `node_modules/<package>/LICENSE*` or in the repository `LICENSE` file.',
);
lines.push('');

fs.writeFileSync(OUTPUT, lines.join('\n'), 'utf8');
console.log(`Wrote ${OUTPUT}`);
console.log(`${all.size} distinct packages, ${byLicense.size} license identifiers.`);
const unknown = byLicense.get('UNKNOWN') || [];
if (unknown.length) {
  console.log(`Packages with UNKNOWN license: ${unknown.map((p) => p.name).join(', ')}`);
}
