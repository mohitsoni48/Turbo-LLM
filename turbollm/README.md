<p align="center">
  <img src="https://raw.githubusercontent.com/mohitsoni48/Turbo-LLM/main/turbollm/web/public/brand/turbollm-icon-512.jpeg?v=2" width="92" height="92" alt="TurboLLM" />
</p>

<h1 align="center">TurboLLM</h1>

<p align="center">
  <strong>Run <em>any</em> local LLM engine, auto-tuned to your GPU — with a polished web UI
  and an OpenAI/Anthropic-compatible API.</strong><br/>
  Bring your own llama.cpp fork. No compiling. No Electron. No Python. Point Claude Code at
  your own machine in one command — fully offline.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/turbollm"><img src="https://img.shields.io/npm/v/turbollm.svg?color=e2552e" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/turbollm"><img src="https://img.shields.io/npm/dm/turbollm.svg?color=e2552e" alt="npm downloads" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg" alt="node >= 22" />
  <img src="https://img.shields.io/badge/license-FSL--1.1--ALv2-blue.svg" alt="license" />
  <img src="https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-555.svg" alt="platforms" />
</p>

<!-- Brand: shipped app icon web/public/brand/turbollm-icon-512.jpeg · high-res masters web/brand-assets/ (unshipped) · in-app mark web/src/components/Logo.tsx · favicon web/public/favicon.svg -->

```bash
npx turbollm
```

That one command starts a local daemon, opens a browser UI, and serves your models over an
API any tool can talk to. TurboLLM is the **performance & bleeding-edge layer for local
LLMs** — built for people who today hand-compile forks and hunt forums for the right flags.

<p align="center">
  <img src="https://raw.githubusercontent.com/mohitsoni48/Turbo-LLM/main/assets/how-it-works.svg?v=2" width="860" alt="How TurboLLM works: clients -> one lightweight daemon -> any engine on your GPU" />
</p>

---

## Contents

- [Why TurboLLM](#why-turbollm)
- [Features](#features)
- [Quick start](#quick-start)
- [⭐ Bring any engine — the headline feature](#-bring-any-engine--the-headline-feature)
- [Models — bring your own, or browse Hugging Face](#models)
- [Auto-tuning & performance](#auto-tuning--performance)
- [Chat](#chat)
- [APIs & integrations](#apis--integrations)
- [Run Claude Code on your own GPU](#run-claude-code-on-your-own-gpu)
- [Use it from any device on your network](#use-it-from-any-device-on-your-network)
- [Share the GPU with ComfyUI](#share-the-gpu-with-comfyui)
- [Command-line reference](#command-line-reference)
- [Configuration & data](#configuration--data)
- [Requirements](#requirements)
- [Privacy](#privacy)
- [How TurboLLM compares](#how-turbollm-compares)
- [Troubleshooting](#troubleshooting)
- [Develop from source](#develop-from-source)
- [License](#license)

---

## Why TurboLLM

Local-LLM tools make two choices for you, and both cost you performance:

1. **They pick the engine.** LM Studio ships one blessed runtime; Ollama hides the engine
   entirely. The fastest community innovations — new quant formats, speculative decoding,
   low-bit KV cache — land in **forks** first, and you can't use them without compiling.
2. **They don't tell you what speed to expect**, and they don't tune the dozens of launch
   flags (`-c`, `-ngl`, `--n-cpu-moe`, KV type, threads, flash-attn, draft models) that make
   the difference between 20 and 80 tokens/sec on the *same* hardware.

TurboLLM does the opposite:

- **🔌 Any engine, including forks.** Point it at any `llama-server`-compatible binary — a
  build you compiled, a community fork, or the one it auto-provisions for your GPU. It probes
  the binary's real capabilities and adapts the UI to them. **This is the whole point.**
- **⚡ Auto-tuned to your hardware.** It benchmarks on load, derives fast defaults, and shows
  a **VRAM-fit verdict before you load** — no more flag guessing.
- **📊 Real tokens/sec, never faked.** Speed in the model list is *measured on your machine*
  from actual generation — live while you chat, and remembered per model.
- **🪶 Lightweight.** A ~0.3 MB npm package on Node — **no Electron, no bundled Chromium, no
  Python**. It downloads only the engine your GPU actually needs (Vulkan ≈ 38 MB).
- **🔌 Drop-in APIs.** OpenAI **and** Anthropic-compatible — so Claude Code and every existing
  tool work unchanged.
- **🔀 A gateway that loads models for you.** Name any model in your API request and TurboLLM
  loads it on demand, keeping your favorites hot in a small pool — so an agent that hops between
  models just works, with nothing to pre-wire.
- **🔒 Offline-first & private.** No account, no backend, no internet, **no telemetry.**

---

## Features

**Engines**
- Bring any `llama-server`-compatible engine — stock builds or community forks — with real capability probing
- Auto-provision a GPU-matched `llama-server` build on first run (CUDA / ROCm / Metal / SYCL / Vulkan, CPU fallback)
- **vLLM** and **MLX** backends in addition to llama.cpp
- One-click backend install + switch from the Engines screen

**Models**
- Use your own local GGUF / safetensors, or browse & download from Hugging Face in-app
- Per-model load profiles (context, GPU offload, KV-cache quant, flash-attn, draft models)
- **Configurable multi-GPU per model** — tensor split / main-GPU pick (llama.cpp), tensor-parallel (vLLM)
- Auto-tune on load with a **VRAM-fit verdict before you load**
- Measured tokens/sec per model — never faked — live while you chat and remembered

**Chat**
- Streaming chat with live t/s, TTFT, context meter, and reasoning/thinking support
- **Persona picker** (8 styles, including Research) + per-chat system prompt and full sampling controls
- **Inline Unicode charts** when a comparison or trend genuinely warrants a visual
- Image and document attachments — including **send an image or file with no text**

**Agentic tools**
- **Built-in tools** — `web_search` (Tavily, advanced depth), `fetch_url`, and sandboxed `run_code`
- **MCP server support** — connect any MCP server (stdio or SSE) from the Customize screen; tools appear automatically in every chat
- **Research persona** — forces multi-step web search before every reply, cites sources inline
- Agentic tool loop with live tool-call cards (pending → done/error) streamed in the UI

**Integrations**
- OpenAI- **and** Anthropic-compatible APIs — run Claude Code on your own GPU
- **Smart gateway** — name a model in any request and it auto-loads; keep up to 4 models hot (LRU)
- **Embeddings** (`/v1/embeddings`) and **structured output** (GBNF grammar / JSON-constrained)
- LAN sharing with optional API-key auth
- **Share the GPU with ComfyUI** — auto-unload the model while ComfyUI renders, reload when it's done

**Platform**
- ~0.3 MB npm package on Node — no Electron, no Chromium, no Python
- Offline-first, no account, no telemetry

---

## Quick start

```bash
# run without installing (recommended for first try)
npx turbollm

# or install globally
npm install -g turbollm
turbollm
```

**On first run** the daemon:

1. Detects your GPU and **downloads a matching `llama-server` build** (CUDA for NVIDIA, ROCm
   for AMD, Metal for Apple, SYCL for Intel, Vulkan otherwise — with a CPU fallback).
2. Starts on <http://127.0.0.1:6996> and opens your browser.
3. Drops you on the **Chat** screen, ready to load a model.

Then open **Models**, download or pick a GGUF, click **Load**, and start chatting. Stop the
daemon any time with **Ctrl+C**.

<!--
  📸 SCREENSHOTS — drop PNGs into assets/screenshots/ and uncomment. Suggested shots:
  - chat.png      : a chat mid-stream showing the live t/s + context meter
  - models.png    : the Models › Library with measured t/s per model
  - engines.png   : the Engines screen + backend picker (the USP)
  - tuning.png    : the model load-params panel (ctx/ngl/NextN/VRAM verdict)
  <p align="center"><img src="https://raw.githubusercontent.com/mohitsoni48/Turbo-LLM/main/assets/screenshots/chat.png" width="860" alt="TurboLLM chat" /></p>
-->

---

## ⭐ Bring any engine — the headline feature

No other local-LLM app lets you run **whatever inference engine you want**. TurboLLM treats
the engine as a swappable component.

**Add a custom engine** (Engines screen → **Add engine**):

1. Compile or download any `llama-server`-compatible binary — stock
   [llama.cpp](https://github.com/ggml-org/llama.cpp), a community fork, or your own build.
2. Point TurboLLM at the binary. It runs a **capability probe** and learns exactly which
   flags and features that build supports.
3. Activate it. The load-parameter UI **adapts to that engine** — features the build doesn't
   support are hidden; ones it adds (e.g. low-bit KV cache, NextN) light up.

**Auto-provisioned default.** Don't want to fetch anything? On first run TurboLLM downloads
the right upstream prebuilt for your GPU automatically — and a **backend picker** lets you
switch between CUDA / ROCm / Metal / SYCL / Vulkan / CPU at any time (it downloads the variant
you choose, LM Studio-style).

**Engine types.** Both **llama.cpp / GGUF** and **MLX** (on macOS) are first-class engine
kinds — pick the right one per model.

**Fully supervised.** Every engine runs under a real state machine: health-gated readiness,
graceful stop, an **idle auto-stop** watchdog, and **live logs + clear error surfacing** in
the UI when something fails to load.

> Why it matters: fork-exclusive features — **speculative decoding (NextN / MTP / draft)**,
> low-bit KV cache, new quant formats — are usable on day 0, with **zero compiler knowledge**
> on your part beyond producing the binary (and often not even that).

---

## Models

- **Use the folders you already have.** Point TurboLLM at any directory of GGUFs — your
  existing LM Studio / Ollama / manual downloads — **no re-downloading.** It parses GGUF
  metadata (arch, params, quant, context, vision) for every file.
- **Browse & download from Hugging Face**, in-app: search, see the file tree, pick a quant,
  and download with **resume + SHA-256 verification**. Gated models (Llama, Gemma) work via
  your own HF token, which **never leaves your machine**.
- **Import from any URL** — not just Hugging Face. Paste a direct `.gguf` link (model-author
  sites, mirrors, private servers); it disk-space-checks and downloads through the same
  manager.
- **Quant recommendation per GPU** and a **VRAM-fit verdict** so you pick a quant that
  actually fits before you commit.
- **Primary download folder**, real-time **measured t/s per model**, and **delete-from-disk**
  — full library management.

---

## Auto-tuning & performance

- **Auto-benchmark on load** derives fast defaults for your exact GPU.
- **Real measured tokens/sec** in the model list — **live** while a model is generating,
  **last-session** when it's idle (never a synthetic estimate).
- **Full load-parameter UI**, a superset of what other tools expose:
  context length, GPU offload (`-ngl`), **MoE CPU-offload (`--n-cpu-moe`)**, parallel slots,
  **KV-cache quant type** (incl. low-bit on supporting forks), CPU threads, flash attention,
  and **speculative decoding (NextN / MTP / draft)**.
- **Fast by default:** flash attention on, NextN self-speculative decoding on for models that
  carry a draft head, threads auto — best speed out of the box, safely gated to what your
  engine actually accepts.
- **Multi-GPU, per model** — split a model across cards (layer/row split + main-GPU pick on
  llama.cpp, tensor-parallel on vLLM). Defaults are no-ops, so single-GPU rigs are untouched and
  the VRAM verdict budgets across the GPUs the split actually uses.
- **Saved per-model profiles** — tune once, and it loads that way every time.

---

## Chat

A genuinely good chat UI, not an afterthought:

- **Streaming** with a **stop** button, **live tokens/sec**, **prompt-processing %** and
  **prefill t/s**, **time-to-first-token**, **total time**, exact **token counts**, and a
  **context-usage meter** (filled / max) on every reply.
- **Thinking control** — toggle reasoning **off** to get a direct answer (saves time and
  tokens), or leave it **on** with collapsible, timed "thought for N s" blocks.
- **Markdown + syntax-highlighted code** with one-click copy — plus **inline Unicode charts**
  the model draws when a comparison, trend, or hierarchy is genuinely worth a visual.
- **Personas** — pick a style (Concise · Detailed · Blunt · Formal · Tutor · Creative · Default)
  per conversation, no prompt-wrangling required.
- **Edit, regenerate, delete, copy** any message; **persistent, searchable conversations**
  with rename, delete, and **auto-generated titles**.
- **Per-chat system prompt** and **per-chat sampling** overrides — the full set: temperature,
  top-p/k, min-p, repeat/presence/frequency penalties, and **stop strings**.
- **Image input** for vision models.
- **TurboLLM Expert** — a built-in assistant that knows the app and your hardware, for
  onboarding and troubleshooting without leaving the UI.

---

## APIs & integrations

With a model loaded, TurboLLM serves two compatible APIs on the same port:

```bash
# OpenAI-compatible
curl http://127.0.0.1:6996/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"local","messages":[{"role":"user","content":"hello"}]}'
```

- **OpenAI-compatible** `/v1/chat/completions`, `/v1/embeddings`, … — point any OpenAI client
  or tool at it. Embedding models are auto-detected and pooled separately, so a RAG pipeline and
  a chat model can stay loaded side by side.
- **Anthropic-compatible** `/v1/messages` — including **tool use and streaming** — which is
  what powers Claude Code below. No other local host offers this.
- **Structured output** — constrain any response to a **GBNF grammar** (or JSON shape) for
  reliable machine-readable results.
- **API-key auth** you can require when sharing over a LAN (Settings → Network).

### The gateway loads models for you

Most local hosts make you load a model first, then call it. TurboLLM's gateway reads the
`model` field of any incoming request, **fuzzy-matches it to your library, and loads it on the
fly** if it isn't already running — then keeps up to **four models hot** in an LRU pool so the
next switch is instant. An agent (or Claude Code) that hops between a coding model, a vision
model, and an embedder just names each one and it works — no pre-wiring, no manual swaps. Tune
it in Settings → Gateway (`autoSwap`, `keepN`).

---

## Run Claude Code on your own GPU

TurboLLM's Anthropic-compatible endpoint means [Claude
Code](https://www.npmjs.com/package/@anthropic-ai/claude-code) can run against whatever model
you've loaded — no cloud key, fully offline. One command wires it up:

```bash
turbollm launch claude          # opens Claude Code on your loaded model
```

It sets Claude Code's `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` at TurboLLM and execs `claude`;
extra args are forwarded. If `claude` isn't installed, it tells you how. The in-app
**Developer** screen also shows copy-paste env snippets for any OpenAI- or Anthropic-compatible
tool (Open WebUI, Kilo Code, opencode, …).

---

## Use it from any device on your network

The UI runs in the browser, so any phone, tablet, or laptop on your LAN can use the model on
your GPU box:

```bash
turbollm --addr 0.0.0.0:6996    # bind all interfaces, then open http://<your-ip>:6996
```

Turn on **Require API key** in Settings → Network when you expose it.

---

## Share the GPU with ComfyUI

If you run **ComfyUI** on the same GPU, an LLM holding VRAM while ComfyUI renders means both
fight for memory (and one usually OOMs). TurboLLM can hand the GPU over automatically:

- The instant ComfyUI starts a render, TurboLLM **unloads its model and pauses new loads**.
- When ComfyUI's queue drains, TurboLLM **reloads the exact model it unloaded**.

It's **push-based, not polling** — ComfyUI signals TurboLLM the moment a job starts/ends, so
the handoff is immediate and deterministic (the model is gone *before* ComfyUI executes).

**One-time setup** (Settings → ComfyUI):

1. Turn on **Pause for ComfyUI** and **Save**.
2. Enter your ComfyUI folder (the one containing `custom_nodes`) and click **Install gate**.
   TurboLLM writes a small custom node into ComfyUI, wired to this daemon.
3. **Restart ComfyUI** once so it loads the node.

The Settings panel shows a live indicator (rendering / idle / connected). To undo it, click
**Remove** in the same panel.

---

## Command-line reference

```bash
turbollm                        # start on :6996, open browser
turbollm --port 9000            # listen on a specific port
turbollm --no-open              # start without opening a browser
turbollm --addr 0.0.0.0:6996    # bind all interfaces (LAN sharing)
turbollm launch claude          # start Claude Code against the loaded model
```

| Flag | Description |
|------|-------------|
| `--port <n>` | Listen on a specific port (default: `6996`) |
| `--addr <host:port>` | Full host:port override, e.g. `0.0.0.0:6996` for LAN sharing |
| `--no-open` | Start without opening a browser window |
| `--config <file>` | Path to a custom config file |
| `--help`, `-h` | Show usage and exit |

---

## Configuration & data

Everything lives under **`~/.turbollm/`** on every OS — `config.json`, the SQLite chat
database, downloaded engines, models cache, and logs. Back it up or delete it to reset.
Use `--config <file>` to point at an alternate config (its directory becomes the data dir).

---

## Requirements

- **Node.js 22 or newer** — enforced at startup with a clear message. <https://nodejs.org>
- **Windows, macOS, or Linux.**
- A GPU is recommended but **not required** — a CPU build is provisioned as a fallback.
- On Windows, the first time the auto-downloaded `llama-server` runs, SmartScreen/Defender may
  prompt (it's an upstream binary). Allow it once.

---

## Privacy

TurboLLM is **offline-first**: core local use needs no account, no backend, and no internet.
**No analytics or telemetry are collected.** Your prompts, chats, files, and keys never leave
your machine.

---

## How TurboLLM compares

Focused on the differences that matter — all four are good tools.

| | **TurboLLM** | LM Studio | Ollama | Open WebUI |
|---|:---:|:---:|:---:|:---:|
| Run **any engine / community forks** | ✅ | ❌ one runtime | ❌ hidden | ❌ |
| **Auto-tune** launch flags to your GPU | ✅ | ❌ | ❌ | ❌ |
| **Measured** t/s in the model list | ✅ | ◐ | ◐ | ❌ |
| **Anthropic** API (tool use) → Claude Code | ✅ | ❌ | ❌ | ❌ |
| OpenAI-compatible API | ✅ | ✅ | ✅ | ◐ proxy |
| **Auto-load the requested model** (hot-swap pool) | ✅ | ❌ | ◐ | ❌ |
| Use existing model folders (no re-download) | ✅ | ◐ | ❌ | ❌ |
| Speculative decoding (NextN / MTP / draft) | ✅ | ◐ draft | ❌ | ❌ |
| Web UI from any LAN device | ✅ | ❌ | ❌ | ✅ |
| **Lightweight** (no Electron / no Python) | ✅ npm | ❌ Electron | ✅ Go | ❌ Python |
| Offline-first · no telemetry | ✅ | ◐ | ✅ | ✅ |

Prefer Open WebUI's chat breadth? It works great pointed at TurboLLM's OpenAI endpoint.

---

## Troubleshooting

- **`TurboLLM requires Node.js 22 or newer`** — upgrade Node: <https://nodejs.org>.
- **Model won't load / OOM** — pick a smaller quant (the VRAM verdict warns you), lower GPU
  offload, or close other GPU apps. Failures surface in the Engines screen with the engine log.
- **Windows Defender / SmartScreen prompt** — that's the upstream `llama-server` binary on
  first run; allow it once.
- **Port already in use** — `turbollm --port 9000`.
- **Slow generation** — open the model's load params; ensure GPU offload is high and flash
  attention / NextN are on for supported models.

---

## Develop from source

```bash
npm install                  # daemon deps
cd web && npm install && cd ..

npm run build:web            # build the React UI -> src/webdist
npm run start                # run the daemon in dev (hot TS via tsx) -> :6996

npm run build                # production bundle -> dist/cli.js (web assets included)
node dist/cli.js --port 6996
```

Frontend hot-reload: `cd web && npm run dev` (proxies `/api` and `/v1` to the daemon on
:6996).

**Stack:** Node ≥22 · TypeScript · Hono · `node:sqlite` · tsup — and a React 19 + Tailwind v4 +
shadcn/ui frontend. One TypeScript codebase, shipped as an npm package.

```
turbollm/
  bin/turbollm.mjs      launcher shim (Node guard) -> dist/cli.js
  src/
    cli.ts              entrypoint: wiring + graceful shutdown
    server.ts           Hono app: CORS, API, gateway, embedded SPA
    engines/            provisioning, probe, registry, lifecycle state machine
    api/routes.ts       /api/v1/* handlers
    gateway/            /v1/* OpenAI + Anthropic gateway
    models/ · chat/ · hf/ · bench/ · downloads/
  web/                  React + TS + Tailwind + shadcn frontend (own package.json)
```

---

## License

Source-available under the **Functional Source License 1.1 (Apache-2.0 future grant)** — SPDX
**`FSL-1.1-ALv2`**. Free for personal use, internal business use, education, and research; the
only restriction is shipping a competing product. Each release converts to Apache-2.0 two
years after it's published. Full text: [LICENSE.md](https://github.com/mohitsoni48/Turbo-LLM/blob/main/turbollm/LICENSE.md).

<p align="center"><sub>Built for people who refuse to wait for the mainstream to bless the fast path. ⚡</sub></p>
