# Kasalix AI Chat

Kasalix is an open-source AI platform for running and using
local AI models through Ollama.

## Original Project

Kasalix is an original project created and maintained by
Filip Kasman.

This project is licensed under the Apache License 2.0.

See [LICENSE](LICENSE) and [NOTICE](NOTICE) for details.



# AI Chat Client for Ollama

A modern chat interface powered by local Ollama models.

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

## Tech Stack

**Frontend:** React 18, TypeScript, Vite, Tailwind CSS, react-markdown, lucide-react
**Backend:** Bun, Hono, TypeScript

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
