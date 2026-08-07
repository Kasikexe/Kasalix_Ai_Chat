# Kasalix AI Chat

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Kasalix is an open-source AI platform for running and using local AI models
through Ollama — with a modern chat interface, streaming responses, a desktop
app, and a standalone server.

## Original Project

Kasalix is an original project created and maintained by Filip Kasman.

This project is licensed under the Apache License 2.0. See
[LICENSE](LICENSE), [NOTICE](NOTICE), and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.

## Features

- Streaming responses with Server-Sent Events
- Markdown rendering with code highlighting
- Multiple conversation management (create, rename, delete)
- Model switching with auto-detection from Ollama
- Auto-generated conversation titles
- Mobile responsive with collapsible sidebar
- Dark mode by default
- Auto-scroll during streaming (with stick-to-bottom detection)
- Stop generation mid-stream
- Persists last selected model
- Desktop app (Electron) and mobile app (Capacitor/Android)
- Standalone server app with generated TLS certificates

## Tech Stack

**Frontend:** React 18, TypeScript, Vite, Tailwind CSS, react-markdown, lucide-react
**Backend:** Bun, Hono, TypeScript
**Desktop:** Electron, electron-builder
**Mobile:** Capacitor

## Prerequisites

- [Bun](https://bun.sh) (>= 1.0)
- [Node.js](https://nodejs.org) (>= 18)
- [Ollama](https://ollama.com) running locally

## Setup

1. **Start Ollama** and pull a model:
   ```bash
   ollama serve
   ollama pull llama3.2
   ```

2. **Backend:**
   ```bash
   cd backend
   bun install
   bun run dev
   ```
   Runs on `http://localhost:3001`

3. **Frontend** (in another terminal):
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
   Runs on `http://localhost:5173`

See [CONTRIBUTING.md](CONTRIBUTING.md) for full development setup details.

## Architecture

The project is split into `backend/` and `frontend/`. The backend proxies all Ollama
requests and provides a stable API plus conversation storage. The frontend is fully
decoupled and can be swapped for another client.

### Backend API

| Method | Endpoint                       | Description                |
| ------ | ------------------------------ | -------------------------- |
| GET    | `/api/models`                  | List Ollama models         |
| POST   | `/api/chat`                    | Stream chat (SSE)          |
| GET    | `/api/conversations`           | List conversations         |
| GET    | `/api/conversations/:id`       | Get single conversation    |
| POST   | `/api/conversations`           | Create conversation        |
| PUT    | `/api/conversations/:id`       | Update title/model         |
| DELETE | `/api/conversations/:id`       | Delete conversation        |

Conversations are stored as JSON in `backend/data/conversations.json`.
Swap `services/storage.ts` for a real database when scaling.

## Future Extensions

The architecture is designed to be provider-agnostic. To add a new provider:

1. Create a new service in `backend/src/services/` (e.g. `openai.ts`, `claude.ts`)
2. Add a route that exposes it under `/api/<provider>/...`
3. Frontend: extend `services/api.ts` with provider-specific calls
4. Add a `provider` field to `Conversation` type and route through a factory

The same applies to image generation, voice, file uploads, and authentication.

## Community

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security](SECURITY.md)

## License

This project is licensed under the [Apache License 2.0](LICENSE).
Third-party software used by this project is listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
