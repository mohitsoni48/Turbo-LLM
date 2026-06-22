# Requirements — fix/mlx-incomplete-shards-and-channel-tokens-v2

## Bug Fixes

1. **TurboQuant installation fails on macOS** — 2026-06-22
   - Root cause: `provisionForkRelease` always queried `/releases/latest`. The fork publishes platform-specific releases (each tag is OS-specific), so the latest tag was a Linux-only release with no macOS asset, causing `no_release_asset` error for all Mac users.
   - Fix: Changed `provisionForkRelease` to fetch `/releases?per_page=100` (newest-first list) and scan for the first release that contains a platform-matching asset, rather than blindly using the latest tag.
   - Fix criteria: Mac users can install TurboQuant; the installer finds the latest macOS release even when a newer Linux release exists.
   - Files changed: `src/engines/download.ts`, `src/engines/catalog.ts`

2. **Catalog `platforms` for TurboQuant was macOS-only** — 2026-06-22
   - Root cause: catalog.ts listed `platforms: ['darwin']` and the note said "Windows/Linux not yet released". But the fork now publishes Linux x64 (Vulkan) builds.
   - Fix: Added `'linux'` to the platforms array; updated the note to reflect actual release coverage.
   - Fix criteria: Linux users see the TurboQuant catalog entry and can install it.

## Dependency Graph
- Bug Fix 2 is a follow-on to Bug Fix 1 (discovered during the same investigation).
