# Project tasks

Mark each task complete after verification. Record the result, relevant links, and the commit hash when available.

## Completed

- [x] **Task 1 — Local API startup and health endpoint** (2026-11-27)
  - `npm run dev` starts the API. The public `GET /api/v1/health` endpoint returns `200` with `ok: true` and the current server time in ISO 8601 UTC. [API contract](docs/04-api-contract.md) · [Server entry point](server/index.js)
  - Verified with `npm.cmd --prefix server ci`, two passing HTTP tests via `npm.cmd --prefix server test`, a live request returning the expected JSON, and `git diff --check`. [Server scripts](server/package.json) · [HTTP tests](server/test/health.test.js)
