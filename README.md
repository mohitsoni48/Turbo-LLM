<h1 align="center">TurboLLM</h1>

<p align="center">
  <strong>Run any local LLM, auto-tuned to your GPU — with a polished web UI and an
  OpenAI/Anthropic-compatible API.</strong><br/>
  Point Claude Code at your own machine in one command. Fully offline, no cloud key.
</p>

---

```bash
npx turbollm
```

That single command starts a local daemon, opens a browser UI, and serves your models over
an API any tool can talk to. TurboLLM manages **any bring-your-own inference engine** (stock
`llama.cpp`, community forks, or a default it provisions for your GPU), **auto-tunes the
launch flags to your hardware**, and shows you **real measured tokens/sec**.

It's the **performance & bleeding-edge layer for local LLMs** — for the people who today
hand-compile forks and hunt forums for the right flags.

## Highlights

- **Any engine, including forks** — not locked to one blessed runtime.
- **Auto-tuned to your hardware** — VRAM-fit verdict before load, fast defaults, no flag guessing.
- **Real tokens/sec** — measured on your machine, never synthetic.
- **A real chat UI** — streaming with live t/s, prefill %, TTFT, context meter; markdown + code; edit/regenerate/delete.
- **Drop-in APIs** — OpenAI *and* Anthropic compatible, so existing tools and agentic CLIs work unchanged.
- **Claude Code in one command** — `turbollm launch claude` runs it against your loaded model.
- **Usable from any device** — browser UI, shareable across your LAN with optional API-key auth.
- **Offline-first & private** — no account, no backend, no internet required. No analytics collected.

## Install & docs

The product is an npm package in [`turbollm/`](turbollm/). See its
[**README**](turbollm/README.md) for full install instructions, CLI flags, the API, and
how to develop from source.

```bash
npm install -g turbollm   # or just: npx turbollm
turbollm                  # start on http://127.0.0.1:6996
turbollm launch claude    # run Claude Code on your loaded model
```

**Requires Node.js 22+.**

## License

Source-available under the **Functional Source License 1.1 (Apache 2.0 future grant)** —
SPDX `FSL-1.1-ALv2`. Free for personal use, internal business use, education, and research;
the only restriction is shipping a competing product. Each release converts to Apache-2.0
two years after publication. Full text: [turbollm/LICENSE.md](turbollm/LICENSE.md).
