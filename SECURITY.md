# Security Policy

## Reporting a Vulnerability

We take security seriously. **Please do not report security issues in the
public issue tracker.**

If you discover a vulnerability, report it privately so it can be fixed before
it is disclosed publicly. Use one of the following channels:

- **GitHub private vulnerability reporting** — the preferred channel if this
  repository is hosted on GitHub (Repository → *Security* → *Report a vulnerability*).
- **GitHub:** open a private discussion or contact the maintainer at
  [@YOUR_GITHUB_HANDLE](https://github.com/Kasikexe)

Please include as much of the following as possible:

- The affected component (`backend/`, `frontend/`, `server-gui/`, …) and version
- A description of the vulnerability and its impact
- Steps to reproduce or a proof-of-concept
- Any suggested fix, if you have one

You will receive an acknowledgement within a few business days, and we will work
with you to understand the issue and coordinate a fix and disclosure.

## Scope

The following are considered in scope:

- Remote code execution, injection, or data exposure in the backend API
- Security issues in the desktop/server Electron apps
- Unsafe handling of user data, conversations, or files
- Dependency vulnerabilities in the packages listed in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

The following are considered **out of scope**:

- Issues in third-party software outside this repository (Ollama, Node.js, Bun,
  Electron, the OS, …) — please report those to their respective projects
- Local-only issues that require physical access to a machine
- Best-practice recommendations without a demonstrated vulnerability

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | ✅ Fully supported |
| older   | ❌ Not supported   |

We only provide security fixes for the latest release. Keep your installation
up to date.

## Disclosure Policy

- Issues are fixed in a private branch, then released with a changelog entry.
- The vulnerability is disclosed after a fix is available.
- Security researchers are credited in the release notes if they wish to be.

Thank you for helping keep Kasalix and its users safe.
