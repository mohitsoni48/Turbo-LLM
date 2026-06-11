# TurboLLM (product code)

The TurboLLM daemon — a **Node.js + TypeScript** app, shipped as an npm package
(`npx turbollm`), that serves a browser web UI and an OpenAI/Anthropic-compatible API
gateway, and manages any bring-your-own inference engine. Stack decision: ADR-023
(supersedes the earlier Go prototype). Behavior is specified in [`../docs/specs/`](../docs/specs/).

## Layout
```
turbollm/
  package.json          npm package; bin "turbollm" -> dist/cli.js
  src/
    cli.ts              entrypoint: wiring + graceful shutdown
    server.ts           Hono app: CORS, API, gateway, embedded SPA
    config/             v2 schema + load/save/migrate (spec 01)
    engines/            probe, registry (A1), lifecycle state machine (A2) (spec 03)
    api/routes.ts       /api/v1/* handlers (spec 02)
    gateway/gateway.ts  /v1/* OpenAI pass-through (spec 06)
    deps.ts             shared dependency bundle
    webdist/            built web UI (generated; served by the daemon)
  web/                  React 19 + TS + Tailwind v4 + shadcn frontend (own package.json)
```

## Milestone status
**A1 (engine registry) + A2 (lifecycle state machine) — ✅ ported to TS & verified.**
- [x] config v2 + M0→v2 migration
- [x] engine registry: add/probe (turbo-KV detection), rename, remove, activate, reprobe
- [x] lifecycle state machine: starting→running (health readiness) / stopping / error + logTail
- [x] graceful stop (taskkill→force), port allocation, idle watchdog, engine logs
- [x] `/api/v1/*` (status, engines, lifecycle, logs+SSE) + `/v1` OpenAI gateway
- [x] daemon serves the React UI (shell + Engines screen), SPA deep-links

Build order & specs: [`../docs/specs/README.md`](../docs/specs/README.md)
(A1→A2→A3→A4→B1→A5→B2→B3→C). Next: **A3** (model directories + GGUF discovery, spec 04).

## Develop & run
```
# install (once)
npm install               # daemon deps (hono, tsx, tsup)
cd web && npm install && cd ..

# build the web UI (-> src/webdist) then run the daemon in dev (hot TS via tsx)
npm run build:web
npm run start             # or: npm run dev   (watch mode)
#   open http://127.0.0.1:8080   ·   curl http://127.0.0.1:8080/api/v1/status

# production bundle (single dist/cli.js with deps bundled)
npm run build             # tsc --noEmit + tsup
node dist/cli.js --addr 127.0.0.1:8080
```
Frontend hot-reload: `cd web && npm run dev` (proxies /api, /v1 to the daemon on :8080).

## Toolchain
Node 25 / npm 11. (Go 1.26.4 is still installed but no longer used — ADR-023.)
Unsigned local runs may be flagged by Windows Defender; production releases must be
code-signed. Do not create dummy `.exe` files.
