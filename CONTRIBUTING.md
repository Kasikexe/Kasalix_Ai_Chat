# Contributing to Kasalix AI Chat

First off, thank you for taking the time to contribute! ❤️

Kasalix is an open-source project. This document describes how to set up the
project, how to make changes, and how to get them merged.

Please also read:

- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — the standards we expect from every contributor
- [README.md](README.md) — project overview and quick start
- [LICENSE](LICENSE) and [NOTICE](NOTICE) — how the project is licensed

## How to report a bug or request a feature

- **Security vulnerabilities** must never be reported in a public issue.
  See [SECURITY.md](SECURITY.md) for the private reporting process.
- For everything else, open a GitHub issue and include:
  - What you expected to happen and what actually happened.
  - Steps to reproduce (code snippets, screenshots, logs).
  - Your environment: OS, Bun/Node versions, Ollama version and model.

## Development setup

### Prerequisites

- [Bun](https://bun.sh) (>= 1.0)
- [Node.js](https://nodejs.org) (>= 18)
- [Ollama](https://ollama.com) running locally

### Running locally

```bash
# 1. Start Ollama and pull a model
ollama serve
ollama pull llama3.2

# 2. Backend (http://localhost:3001)
cd backend
bun install
bun run dev

# 3. Frontend (http://localhost:5173), in another terminal
cd frontend
npm install
npm run dev
```

### Repository layout

| Directory           | Purpose                                        |
| ------------------- | ---------------------------------------------- |
| `backend/`          | Bun + Hono API, conversation storage, Ollama proxy |
| `frontend/`         | React + Vite UI, Electron desktop app, Capacitor mobile app |
| `server-gui/`       | Electron GUI for the standalone server app     |
| `changelog-tool/`   | CLI for managing `changelog.json` entries      |
| `dev-build-tool/`   | Build automation and license report generator  |
| `certs/`            | Auto-generated TLS certificates (git-ignored, script is tracked) |

## Making changes

1. Fork the repository and create a branch from `main`:
   ```bash
   git checkout -b feature/your-feature
   ```
2. Make your changes. Keep them focused — one logical change per pull request.
3. Follow the existing code style and conventions of the code you touch.
4. If you change dependencies, run the license report generator afterwards:
   ```bash
   cd dev-build-tool
   node generate-licenses.mjs   # regenerates THIRD_PARTY_NOTICES.md
   ```
5. Test your changes locally before submitting (see below).
6. Commit with a clear, descriptive message and open a pull request.

## Testing

- **Backend:** run `bun run dev` in `backend/` and exercise the API.
- **Frontend:** run `npm run build` in `frontend/` — this runs the TypeScript
  compiler (`tsc -b`) and Vite, and will surface type errors.
- **Desktop:** `npm run electron:dev` in `frontend/` for the Electron shell.
- **Server app:** use `dev-build-tool` scripts to build the Electron/Android artifacts.

If you can, add a short description of how you verified your change in the
pull request description.

## Commit conventions

The project uses [Conventional Commits](https://www.conventionalcommits.org/)-style
messages, for example:

```
feat(chat): add model temperature slider
fix(backend): handle empty conversation titles
docs(readme): document the desktop build
chore(changelog): add v0.9.0 entry
```

## Pull request process

1. Make sure your branch is up to date with `main`.
2. Open the pull request and describe what you changed and why.
3. A maintainer will review it. Address review feedback in new commits;
   avoid force-pushing once review has started.
4. Once approved, the PR will be merged.

## Attribution

Contributors are credited in the changelog and release notes. By contributing,
you agree that your contributions are provided under the same license as the
project (Apache-2.0), as described in [LICENSE](LICENSE).

Questions? Open an issue or start a discussion — we're happy to help.
