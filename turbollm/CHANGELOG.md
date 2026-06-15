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
