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
</p>

```bash
npx turbollm
```

One command starts a local daemon, opens a browser UI, and serves your models over an API any
tool can talk to. TurboLLM is the **performance & bleeding-edge layer for local LLMs** — for
people who today hand-compile forks and hunt forums for the right flags.

<p align="center">
  <img src="https://raw.githubusercontent.com/mohitsoni48/Turbo-LLM/main/assets/how-it-works.svg?v=2" width="860" alt="How TurboLLM works: clients -> one lightweight daemon -> any engine on your GPU" />
</p>

## Why it's different

- **🔌 Any engine, including forks.** Point it at any `llama-server`-compatible binary — a
  build you compiled, a community fork, or the one it auto-provisions for your GPU. No other
  local-LLM app does this. *This is the whole point.*
- **⚡ Auto-tuned to your hardware** — benchmarks on load, derives fast launch flags, shows a
  VRAM-fit verdict before you load.
- **📊 Real measured tokens/sec** — live while you chat, remembered per model. Never faked.
- **🪶 Lightweight** — a ~0.3 MB npm package on Node. No Electron, no Chromium, no Python.
- **🔌 OpenAI + Anthropic APIs** — run **Claude Code** on your own GPU in one command.
- **🔒 Offline-first & private** — no account, no backend, no telemetry.

## Install

```bash
npm install -g turbollm   # or just: npx turbollm
turbollm                  # start on http://127.0.0.1:6996, open the UI
turbollm launch claude    # run Claude Code against your loaded model
```

**Requires Node.js 22+.** Works on Windows, macOS, and Linux.

## How it compares

| | **TurboLLM** | LM Studio | Ollama | Open WebUI |
|---|:---:|:---:|:---:|:---:|
| Run **any engine / forks** | ✅ | ❌ | ❌ | ❌ |
| **Auto-tune** flags to your GPU | ✅ | ❌ | ❌ | ❌ |
| **Anthropic** API → Claude Code | ✅ | ❌ | ❌ | ❌ |
| Use existing model folders | ✅ | ◐ | ❌ | ❌ |
| Lightweight (no Electron/Python) | ✅ | ❌ | ✅ | ❌ |
| Offline · no telemetry | ✅ | ◐ | ✅ | ✅ |

## 📖 Full documentation

The complete catalogue + manual — every feature, the API, CLI reference, tuning, and how to
**add a custom engine** — lives in **[turbollm/README.md](turbollm/README.md)**.

## License

Source-available under the **Functional Source License 1.1 (Apache-2.0 future grant)** — SPDX
`FSL-1.1-ALv2`. Free for personal, internal-business, educational, and research use; only
shipping a competing product is restricted. Converts to Apache-2.0 two years after each
release. Full text: [turbollm/LICENSE.md](turbollm/LICENSE.md).
