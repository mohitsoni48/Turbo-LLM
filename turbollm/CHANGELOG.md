# Changelog

All notable changes to **TurboLLM** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## How releases work

We tie one **git tag** to every **npm publish**, and accumulate changes under
`[Unreleased]` between publishes. To cut a release:

1. Move the `[Unreleased]` notes into a new `## [x.y.z] - YYYY-MM-DD` section.
2. Bump `version` in `package.json` to `x.y.z`.
3. Commit: `chore(release): vx.y.z`.
4. Tag it: `git tag vx.y.z` (matches the npm version, prefixed with `v`).
5. `npm publish`, then `git push && git push --tags`.
6. (Optional) Create a GitHub Release from the tag, pasting that section's notes.

So "what's new since the last publish" is always the `[Unreleased]` section, and every
published version on npm has a matching `vX.Y.Z` tag in git.

---

## [Unreleased]

_Nothing yet._

## [0.8.0] - 2026-06-19

### Added
- **Research v2** — pluggable web-search providers (Tavily / Kagi / SearXNG); a deterministic
  retrieval service with a confidence loop and a sources panel; and a heuristic referee that flags
  reply claims not supported by their cited sources.
- **Chat portability** — share a chat via a LAN link or a debug snapshot, and export/import chats
  as `.turbollm-chat.json` (imported chats are fully continuable).
- **Agentic tool security** — SSRF/RFC-1918 block on `fetch_url` and a confirmation gate on `run_code`.
- **vLLM load controls** — max model length, GPU memory utilization, max concurrent sequences,
  dtype, KV-cache dtype, enforce-eager, trust-remote-code.
- **Engine lifecycle** — 3-state engine rows (Install / Update / Disable / Enable / Delete) for both
  the catalog engines (vLLM / MLX / TurboQuant) and the llama.cpp backends.
- **"All" models view** — list models unfiltered by the active engine, with compatibility badges.
- **Auto-tune** — live prefill-% progress and a Save / Cancel results dialog.

### Changed
- **Auto-tune** rewritten — binary search over GPU offload, a realistic bench prompt
  (`min(50k, 0.75 × ctx)`), a 3-minute-per-test cap, GPU settle between candidates, and a
  spill-aware peak confirmation (a config that spills VRAM to system memory is PCIe-bottlenecked,
  so throughput peaks at the no-spill edge).
- Stop / restart / load now act as **kill switches** — they cancel a running auto-tune and abort
  in-flight chat generations.
- The model load dialog is driven by the active engine kind (vLLM shows its real controls, not MLX
  copy); slim custom scrollbar; real GPU-layer count instead of "99".
- `turbollm launch claude` raises the request timeout so slow local models don't trigger retries.

### Fixed
- Claude Code context meter and cache-hit now show real numbers (gateway maps engine token usage to
  the Anthropic usage block).
- Qwen tool-loop empty reply after web searches (forced final answer pass).
- vLLM now fails fast with a clear message where it can't run (e.g. Windows), instead of a raw crash.
- ComfyUI reverse-gate log noise when ComfyUI is configured but not running.
- A stale engine error now resets when you switch the active engine.

## [0.7.2] - 2026-06-19

### Fixed
- **Engine load lock** — a static `Manager.loadGate` gate (shared across every Manager
  instance, including the gateway keep-N pool) ensures at most one model load/reload is ever
  in flight at a time. New `load()` method is the single entry point: stops the current engine,
  runs the ComfyUI reverse gate, spawns, and awaits readiness — all as one atomic operation.
  Eliminates the double-VRAM-allocation race when gateway auto-swap and a concurrent HTTP load
  fire simultaneously.
- **Orphan-engine reaping** — each engine records a pidfile (`run/engine-{pid}.pid`) carrying
  its port and owner-daemon pid. On startup, `reapStaleEngines()` kills any engine whose port
  is still live but whose owner daemon is gone (terminal closed, killed, crashed). A sync
  `killTrackedEnginesSync()` on process `exit` covers exits that bypass signal handlers.
  Owner-aware: a restarting daemon never reaps engines owned by the incoming process.
- **Client-cancel propagation** — the gateway wires an `AbortController` into every upstream
  engine fetch (`/v1/messages` and the OpenAI passthrough). `stream.onAbort` fires `ac.abort()`
  so a cancelled Claude turn actually stops the engine generating instead of running to
  completion and clogging its queue slot. `streamToAnthropic` uses `reader.cancel()` (not
  `releaseLock()`) so the upstream body tears down on client disconnect.
- **Daemon crash on client disconnect** — guarded the final `writeSSE('done')` in chat routes
  with a try/catch; added an `unhandledRejection` handler in the CLI that swallows expected
  `AbortError`s. A disconnecting client can no longer crash the daemon and orphan the engine.
- **`SIGHUP` handled** — added to the graceful-shutdown signal set so daemon manager restarts
  don't leave engines running.
- **ModelRouter `waitReady` eliminated** — readiness is now awaited inside `Manager.load()`
  under the load lock; `ModelRouter` just reads `status().state` after `load()` resolves.

## [0.7.1] - 2026-06-18

### Fixed
- **MLX incomplete shard detection** — scanner reads `model.safetensors.index.json` and verifies
  every listed shard exists on disk; partial downloads now surface as `incomplete: true` (blocks
  load) instead of letting mlx-lm crash with `ValueError: Missing N parameters`.
- **GPT-OSS channel streaming** — 4-phase state machine (`initial → reasoning → skipFinal →
  content`) correctly routes `<|channel|>analysis<|message|>…<|end|>` to reasoning events and
  the final answer to delta events; fixes channel framing tokens leaking into chat when whitespace
  separates `<|end|>` from `<|start|>assistant…`.
- **`delta.reasoning` field** — mlx-lm's reasoning field (`delta.reasoning`) now handled
  alongside llama-server's `delta.reasoning_content`.
- **Re-download button for incomplete models** — `inferRepoFromPath` now accepts MLX directory
  paths (2 segments) so the HF repo dialog opens correctly instead of always falling back to
  name-search.

## [0.7.0] - 2026-06-18

### Added
- **Agentic tool loop** — native `finish_reason: tool_calls` detection with up to 10 iterations;
  streams live tool-call cards (pending → done/error) in the chat UI as tools execute.
- **Built-in tools** — `web_search` (Tavily REST API, `search_depth: advanced`), `fetch_url`
  (HTML-stripped page text), and `run_code` (sandboxed Node.js `vm` — no network/file access).
- **MCP host client** — connect any MCP server via stdio subprocess or SSE HTTP transport;
  tools from all connected servers appear automatically in the tool list.
- **Customize screen** — new `/customize` nav item (Puzzle icon) for Tavily API key management
  and MCP server add/edit/delete. Settings is now focused on engine/model/network/startup/persona.
- **Research persona** — always fires `web_search` before composing a reply; `tool_choice` is
  forced at the protocol level for the first two iterations, guaranteeing at least two distinct
  searches; system prompt mandates a 3–5 query strategy with source citation.
- **Current-date injection** — today's date is baked into every new conversation's system prompt
  so temporal queries use the correct year without extra user instruction.
- **DB migration v5+v6** — `tool_calls` column on messages (persists tool invocation history);
  `tool_policy` column on conversations (drives per-conversation tool-choice enforcement).

### Changed
- Settings screen no longer contains Tools or MCP sections — both moved to the new Customize screen.
- Persona count increased to 8 (added Research); persona descriptions updated.

## [0.3.0] - 2026-06-17

### Added
- **Configurable multi-GPU, per model** — new GPU controls on each model's load profile,
  shown (only when more than one GPU is detected) in the model's Load settings:
  - **llama.cpp / TurboQuant:** split mode (`layer` / `row` / `none`), an optional custom
    per-GPU split, and a main-GPU pick — mapped to `--split-mode` / `--tensor-split` /
    `--main-gpu`.
  - **vLLM:** a tensor-parallel size that shards the model across N GPUs
    (`--tensor-parallel-size`).

  Defaults are no-ops, so single-GPU machines and existing profiles are unchanged. The VRAM
  estimate now budgets across the GPUs the chosen split actually uses (previously it only
  counted the first GPU).
- **Reverse ComfyUI GPU gate** — the symmetric direction of the 0.2.0 GPU coordination:
  when you run a prompt in TurboLLM, it first asks ComfyUI to free its VRAM, then loads, so
  whichever app you're actively driving wins the GPU automatically — in both directions. An
  in-flight render is never interrupted. Enable in Settings → ComfyUI.

### Changed
- **Live prefill % is now co-located with the session stats on the engine card**, at a
  larger size and higher contrast, so the headline live-progress signal is legible at a
  glance while a prompt runs.

## [0.2.0] - 2026-06-15

### Added
- **Share the GPU with ComfyUI** — push-based GPU coordination. A one-time-installed
  ComfyUI custom node signals TurboLLM the instant a render starts/ends; TurboLLM unloads
  its model and blocks new loads while ComfyUI renders, then reloads the exact model when
  the queue drains. Installed from Settings → ComfyUI (no polling; deterministic handoff).
- **vLLM** and **MLX** engine backends alongside llama.cpp, with one-click install/switch
  and an engine catalog. Model content hashing for provenance/dedup.
- **Live prefill % + generated-token count on the engine card for gateway traffic** —
  Claude Code (and any external API client) now shows the same live prompt-processing %
  and running token count as in-app chat, instead of a quiet card mid-request.
- **Global max response-token limit** — a "Max response tokens" setting (0 = unlimited)
  that caps generation for in-app chat and clamps external (Claude Code) requests too,
  so nothing on the machine can exceed it.

### Fixed
- Chat now accepts an **image- or file-only message with no typed text** (the server no
  longer rejects attachments that arrive without `content`).

---

## [0.1.1]

Published to npm. (Baseline before this changelog was started; see git history.)

## [0.1.0] - tagged `v0.1.0`

Initial tagged release. (See git history for details.)
