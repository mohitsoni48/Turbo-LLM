<p align="center">
  <img src="https://raw.githubusercontent.com/mohitsoni48/Turbo-LLM/main/turbollm/web/public/brand/turbollm-icon-512.jpeg" width="96" height="96" alt="TurboLLM" />
</p>

<h1 align="center">TurboLLM</h1>

<p align="center">
  <strong>Run any local LLM, auto-tuned to your GPU — with a polished web UI and an
  OpenAI/Anthropic-compatible API.</strong><br/>
  Point Claude Code at your own machine in one command. Fully offline, no cloud key.
</p>

<!-- Brand: shipped app icon web/public/brand/turbollm-icon-512.jpeg · high-res masters web/brand-assets/ (unshipped) · in-app mark web/src/components/Logo.tsx · favicon web/public/favicon.svg -->

---

TurboLLM is a single command — `npx turbollm` — that starts a local daemon, opens a
browser UI, and serves your models over an API any tool can talk to. It manages **any
bring-your-own inference engine** (stock `llama.cpp`, community forks, or a default it
provisions for you), **auto-tunes the launch flags to your exact hardware**, and shows you
**real measured tokens/sec**.

It's built for the prosumer/indie-dev who today hand-compiles forks and hunts forums for
the right flags — not as "another easy chat app," but as the **performance & bleeding-edge
layer for local LLMs**.

## Why TurboLLM

- **Any engine, including forks.** Most tools lock you to one blessed runtime. TurboLLM
  makes any `llama-server`-compatible binary a first-class choice — point it at a build you
  compiled, or let it auto-provision the right prebuilt for your GPU (CUDA / ROCm / Metal /
  SYCL / Vulkan, picked by detected vendor).
- **Auto-tuned to your hardware.** It benchmarks on load and derives fast defaults (flash
  attention, speculative decoding / NextN, context, offload, KV-cache type, threads) with a
  VRAM-fit verdict *before* you load — no more guessing flags.
- **Real tokens/sec, never fake.** Speed shown in the model list is measured on your
  machine from actual generation, not a synthetic estimate.
- **A real chat UI.** Streaming with live t/s, prefill %, TTFT and full stats; markdown +
  code highlighting; collapsible thinking blocks; edit / regenerate / delete / copy;
  persistent searchable conversations; image input for vision models; per-chat system
  prompt and sampling.
- **Drop-in APIs.** OpenAI **and** Anthropic-compatible endpoints, so existing tools and
  agentic CLIs work unchanged.
- **Usable from any device.** The web UI runs in the browser and can be shared across your
  LAN (with optional API-key auth), not locked to the machine it runs on.
- **Bring your own models.** Point it at folders you already have (no re-download), or
  browse and download GGUFs from Hugging Face — or any direct URL — inside the app.
- **Offline-first & private.** Core local use needs no account, no backend, no internet.
  No analytics are collected.

## Requirements

- **Node.js 22 or newer** — the daemon enforces this at startup and exits with a clear
  message if the version is too old. Download: <https://nodejs.org>
- A GPU is recommended but not required (a CPU build is provisioned as a fallback).

## Quick start

```bash
# run directly without installing (recommended for first try)
npx turbollm

# or install globally, then run
npm install -g turbollm
turbollm
```

The daemon starts, prints the local URL (default <http://127.0.0.1:6996>), and opens your
browser. On first run with no engine configured, it downloads a suitable prebuilt
`llama-server` for your hardware automatically. Stop the daemon with **Ctrl+C**.

Then, in the UI: open **Models**, download or pick a GGUF, and load it.

## Use your local model with Claude Code

TurboLLM serves an Anthropic-compatible API, so coding CLIs like
[Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code) can run against
whatever model you have loaded — no cloud key, fully offline. One command wires it up:

```bash
turbollm launch claude          # opens Claude Code on your loaded model
```

This requires the daemon running with a model loaded. It points Claude Code's
`ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` at TurboLLM and execs `claude`; extra args are
forwarded (`turbollm launch claude --help`). If `claude` isn't installed, the command tells
you how (`npm install -g @anthropic-ai/claude-code`). The in-app **Developer** screen also
shows manual env-var snippets for any OpenAI- or Anthropic-compatible tool.

## Command-line usage

```bash
turbollm                        # start on :6996, open browser
turbollm --port 9000            # listen on a specific port
turbollm --no-open              # start without opening a browser
turbollm --addr 0.0.0.0:6996    # bind all interfaces (LAN sharing)
turbollm launch claude          # start Claude Code against the loaded model
```

| Flag | Description |
|------|-------------|
| `--port <n>` | Listen on a specific port (default: 6996) |
| `--addr <host:port>` | Full host:port override, e.g. `0.0.0.0:6996` for LAN sharing |
| `--no-open` | Start without opening a browser window |
| `--config <file>` | Path to a custom config file |
| `--help`, `-h` | Show usage and exit |

State (config, database, downloaded engines and models) lives under **`~/.turbollm/`**.

## API

With a model loaded, TurboLLM serves two compatible APIs on the same port:

```bash
# OpenAI-compatible
curl http://127.0.0.1:6996/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"local","messages":[{"role":"user","content":"hello"}]}'
```

The Anthropic-compatible endpoint (`/v1/messages`, including tool use and streaming) powers
the Claude Code integration above. When sharing over a LAN you can require an API key —
enable it in **Settings → Network**.

## Develop & run from source

```bash
npm install                  # daemon deps
cd web && npm install && cd ..

npm run build:web            # build the React UI -> src/webdist
npm run start                # run the daemon in dev (hot TS via tsx)
#   open http://127.0.0.1:6996   ·   curl http://127.0.0.1:6996/api/v1/status

npm run build                # production bundle -> dist/cli.js (web assets included)
node dist/cli.js --port 6996
```

Frontend hot-reload: `cd web && npm run dev` (proxies `/api` and `/v1` to the daemon on
:6996).

### Layout

```
turbollm/
  package.json          npm package; bin "turbollm" -> bin/turbollm.mjs -> dist/cli.js
  src/
    cli.ts              entrypoint: wiring + graceful shutdown
    server.ts           Hono app: CORS, API, gateway, embedded SPA
    config/             config schema + load/save/migrate
    engines/            provisioning, probe, registry, lifecycle state machine
    api/routes.ts       /api/v1/* handlers
    gateway/            /v1/* OpenAI + Anthropic gateway
    webdist/            built web UI (generated; served by the daemon)
  web/                  React 19 + TS + Tailwind v4 + shadcn frontend (own package.json)
```

## License

Source-available under the **Functional Source License 1.1 (Apache 2.0 future grant)** —
SPDX `FSL-1.1-ALv2`. Free for personal use, internal business use, education, and research;
the only restriction is shipping a competing product. Each release converts to Apache-2.0
two years after it's published. Full text in [LICENSE.md](LICENSE.md).
