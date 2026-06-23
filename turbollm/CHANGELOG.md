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

## [1.4.0] - 2026-06-23

**Hygiene release — the small gaps that made the tool feel unfinished: stop the daemon from the CLI, launch Claude Code without pre-loading a model, see gateway-loaded models as loaded, and import chats from ChatGPT/Claude JSON.**

### Added
- **`turbollm --stop`.** Gracefully stop a running daemon from any terminal (reads a pidfile
  at `~/.turbollm/daemon.pid`). Unix sends SIGTERM then escalates to SIGKILL; Windows uses
  `taskkill /T /F`. Before killing it confirms a TurboLLM daemon is actually answering on the
  recorded port, so a stale pidfile whose PID the OS reused is never mistaken for the daemon.
- **`turbollm launch claude --model <key|name>`.** Load a specific model, then launch Claude
  Code against it. Resolves by exact key, exact name, or partial/case-insensitive name.
- **`turbollm launch claude` auto-loads a model** when none is running — the last-used model
  if known, otherwise the first in your library — so you no longer have to load one first.
- **Import chats from OpenAI-format JSON.** The chat importer now also accepts a standard
  `[{role, content}]` array (or `{messages: [...]}`) exported from ChatGPT, Claude, LM Studio,
  etc., auto-detecting it alongside the existing `.turbollm-chat.json` format.

### Fixed
- **Models loaded by the gateway now show as loaded** on the Models page. With keep-N > 1 a
  model auto-swapped in by a client lived in a separate pool slot that the Models page didn't
  consult, so it appeared unloaded; the page now reflects the whole keep-N pool.

## [1.3.2] - 2026-06-22

**TurboQuant now installs on macOS end-to-end — the Gatekeeper quarantine block, the per-platform release scan, and the Metal first-run timeout are all fixed — plus a Linux build.**

### Added
- **CPU option on macOS.** The Apple-Silicon Metal binary also runs CPU-only, so it now appears
  as a separate CPU backend too — the engine recommender always has a CPU variant to fall back to.
- **TurboQuant on Linux.** Linux x64 (Vulkan) is now listed as installable in the engine catalog.

### Fixed
- **macOS Gatekeeper blocking engine binaries.** Downloaded engine binaries carry the
  `com.apple.quarantine` attribute, which Gatekeeper uses to block execution — so the engine
  probe timed out even after the right binary downloaded. TurboLLM now strips the quarantine
  attribute from every extracted engine on macOS (and on re-install). Thanks @manish026.
- **TurboQuant install/update failing on macOS** with `no_release_asset`. The resolver used
  GitHub's `/releases/latest`, but TurboQuant publishes one release per OS, so the latest tag was
  often Linux-only and Mac users got nothing. It now scans releases for the newest one carrying a
  binary for the current platform.
- **Metal engines timing out on first launch.** macOS Metal builds JIT-compile their shaders on
  first run (10–30 s), which overran the 10 s probe and failed the engine. The probe now allows
  60 s on macOS (15 s elsewhere).

### Changed
- Unified TurboQuant's install and update paths onto a single per-platform release resolver so
  they can't drift apart, and removed the now-dead duplicate code.

## [1.3.0] - 2026-06-22

**End-to-end engine builds — compile a CUDA llama.cpp (or any fork) from inside the app, downloading CUDA itself if you don't have it.**

### Added
- **1-click build from source (Windows + CUDA).** The build guide now compiles for you:
  clone → `cmake` configure → compile `llama-server` → bundle its CUDA runtime → auto-register
  + activate the result, with a live phase + streaming compiler log and a **success screen**
  when the engine is ready. No copy-pasting commands. The manual command path is kept as a
  fallback. Builds with **Ninja inside the MSVC dev environment** (driving `nvcc` directly), so
  a standalone / conda CUDA works where the Visual Studio generator can't.
- **Automatic CUDA download.** No CUDA Toolkit? Click **Download CUDA** — TurboLLM fetches
  NVIDIA's official build components (nvcc + cudart + cuBLAS + headers, ~0.5 GB) and assembles a
  toolkit for you, picking a version your GPU driver supports. No NVIDIA installer, no account.
- **Self-contained builds.** The built engine bundles the CUDA runtime DLLs next to its binary,
  so it runs even without a CUDA Toolkit on PATH (and is portable).
- **Build environment (PATH override).** If your CUDA Toolkit or compiler lives in a conda
  env or a custom location (so `nvcc` wasn't on the system PATH and showed as "not
  available"), add that folder under **Build environment** and hit **Re-check** — those
  dirs are prepended to PATH for both prerequisite detection and the actual build.
- **One-click rebuild.** The "newer source available" chip on source-built engines now
  recompiles at the latest commit in place, instead of just linking to the repo.

### Changed
- Compile-from-source is no longer guidance-only; the prerequisite checker and the build
  both honor the configured toolchain dirs.

## [1.2.1] - 2026-06-22

**Auto-tuning that knows the model, a roomier config panel, and a built-in update check.**
Bundles the work tracked internally as 1.1.0 + 1.2.0 + 1.2.1 into one release off 1.0.0.

### Added
- **Auto-tune reads the model card** — after a sweep, TurboLLM reads the model's Hugging Face
  card and prefills the profile's sampling (temperature / top_k / top_p / min_p) with the
  author's recommended values, shown in the results dialog and applied on Save. Hybrid
  extraction: a deterministic scan first, then the just-tuned model itself as a fallback for
  prose-only cards. No card / no recommendation → your sampling is left unchanged.
- **Base-model fallback for recommended sampling** — most local GGUFs are third-party requants
  whose card omits the recommendation, so TurboLLM resolves the original model (via HF
  `base_model`) and reads its card. Well-known models (Gemma, Qwen, GLM, …) now get their
  recommended sampling even from a bare requant repo. Gated bases (e.g. Gemma) need a
  configured HuggingFace token.
- **Complete tuned config as a table** in the auto-tune results dialog — runtime (GPU layers,
  MoE offload, context, KV cache, flash attention), the full sampling (values from the card
  tagged "from card"), and measured speed / VRAM / first-token latency.
- **App self-update check** — Settings → About shows the running version and, when a newer
  TurboLLM is published on npm, an "update available" chip with a copy-paste
  `npm i -g turbollm` command. Cached 24h; silent when offline; never auto-updates.

### Changed
- **Model config is now a resizable side panel** — load/tune settings open as a right-docked
  panel that resizes the page instead of overlaying it (drag the edge to resize; width is
  remembered), shared by the Models screen and the Chat header. On narrow screens it becomes
  a full-screen takeover.

### Fixed
- Card-sampling extraction now works on **reasoning models** (Gemma 4, Qwen3) — thinking is
  disabled for the extraction step, so they emit usable JSON instead of empty or truncated
  output.
- **Large model cards** (e.g. Qwen3.5, ~80–95k chars) — the recommended-settings block deep
  in the card is now within the extraction window; values inside usage code blocks are
  ignored so demo numbers aren't mistaken for recommendations.

## [1.0.0] - 2026-06-21

**The engine overhaul — TurboLLM 1.0.** Engines are now hardware-aware, self-updating, and
bring-your-own from any source, behind a redesigned, beginner-first Engines screen.

### Added
- **Hardware-aware recommendation** — detects your GPU + OS and labels each engine by fit
  ("Recommended for you"); engines that can't run here are greyed with the reason.
- **Unified, fit-labeled engine catalog** — llama.cpp, KoboldCpp, llamafile, MLX, vLLM, plus
  forks (ik_llama, TurboQuant) — install and manage from one place.
- **KoboldCpp** and **llamafile** as first-class engine kinds (GGUF, OpenAI-compatible),
  verified end-to-end.
- **Guided "Add your own engine"** — pick a folder; TurboLLM scans for the server binary,
  probes its version + capabilities, and pre-fills the name. Optional source-repo URL.
- **Build-from-source guide** (Windows + CUDA) — prerequisite checker (git / CMake / CUDA /
  MSVC) + the exact build commands, then a handoff to "Add your own engine".
- **Honest engine updates** — checks the real upstream release / commit (and PyPI for
  pip engines); per-engine **Off / Notify / Auto** policy (default Notify); rollback-safe
  apply; a **"Rebuild available"** chip for source builds.
- **"Register my engine"** — nominate a fork via a prefilled GitHub issue form.
- **HuggingFace cache as a default model folder** on first run — your existing HF models
  appear with zero configuration.
- Grouped engine selection — one engine dropdown; a version dropdown (with a "latest" badge)
  appears only when you have more than one build.

### Changed
- **Redesigned Engines screen** — three calm zones: a status hero (hardware + a "Running now"
  switcher) → the unified Install & manage catalog → a collapsed Advanced section (GPU build
  picker + backend management). Replaces the old two-level Engine→Build selector + help accordion.
- De-pinned official llama.cpp for updates — the pinned build is now the first-install default only.
- **Route-level code-splitting** — initial JS bundle ~1 MB → ~314 kB; screens load on demand.

### Fixed
- "You're on the latest" was misleading for official llama.cpp (it only checked the pinned build
  on disk) — it now checks the real upstream release.
- llamafile launch on current versions (`--no-webui`, replacing the removed `--nobrowser`).
- Cross-engine KV-cache-type bleed — a model tuned under TurboQuant (turbo2/3/4 KV) no longer
  crashes standard llama.cpp / llamafile; the KV type is gated to what the engine actually supports.

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
