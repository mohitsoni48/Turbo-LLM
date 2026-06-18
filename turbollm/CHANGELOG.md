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
