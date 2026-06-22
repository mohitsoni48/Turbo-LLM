// Tests for scoreAsset, pickReleaseAsset, and findPlatformAsset (ADR-044).
// These cover the asset-matching logic for all supported platforms / arches,
// and the per-platform release-scan that replaced /releases/latest (the fix
// for forks like TurboQuant that publish one OS per tag in newest-first order).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreAsset, pickReleaseAsset, findPlatformAsset } from './download'
import type { ReleaseAsset } from './download'

// ─── helpers ──────────────────────────────────────────────────────────────────

function asset(name: string): ReleaseAsset {
  return { name, browser_download_url: `https://example.com/${name}` }
}

// ─── scoreAsset ───────────────────────────────────────────────────────────────

// Non-archive formats

test('scoreAsset rejects non-archive files regardless of platform', () => {
  assert.equal(scoreAsset('llama-server-macos-arm64.dmg', 'darwin', 'arm64'), -1)
  assert.equal(scoreAsset('llama-server.sha256', 'darwin', 'arm64'), -1)
  assert.equal(scoreAsset('README.md', 'linux', 'x64'), -1)
  assert.equal(scoreAsset('llama-server', 'linux', 'x64'), -1)
})

// macOS arm64

test('scoreAsset scores macOS arm64 asset for darwin/arm64', () => {
  assert.ok(scoreAsset('llama-turboquant-macos-arm64.tar.gz', 'darwin', 'arm64') > 0)
})

test('scoreAsset scores darwin asset for darwin/arm64', () => {
  assert.ok(scoreAsset('llama-b9608-bin-darwin-arm64.tar.gz', 'darwin', 'arm64') > 0)
})

test('scoreAsset rejects macOS arm64 asset on darwin/x64', () => {
  assert.equal(scoreAsset('llama-turboquant-macos-arm64.tar.gz', 'darwin', 'x64'), -1)
})

test('scoreAsset rejects Linux asset on darwin/arm64', () => {
  assert.equal(scoreAsset('llama-turboquant-linux-x64-vulkan.tar.gz', 'darwin', 'arm64'), -1)
})

test('scoreAsset rejects Windows asset on darwin/arm64', () => {
  assert.equal(scoreAsset('llama-server-win-x64.zip', 'darwin', 'arm64'), -1)
})

// macOS x64

test('scoreAsset scores macOS x64 asset for darwin/x64', () => {
  assert.ok(scoreAsset('llama-bin-macos-x64.tar.gz', 'darwin', 'x64') > 0)
})

test('scoreAsset rejects macOS arm64 asset on darwin/x64', () => {
  assert.equal(scoreAsset('llama-bin-macos-arm64.tar.gz', 'darwin', 'x64'), -1)
})

// Linux x64

test('scoreAsset scores Linux x64 asset for linux/x64', () => {
  assert.ok(scoreAsset('llama-turboquant-linux-x64-vulkan.tar.gz', 'linux', 'x64') > 0)
})

test('scoreAsset scores linux ubuntu asset for linux/x64', () => {
  assert.ok(scoreAsset('llama-b9608-bin-ubuntu-vulkan-x64.tar.gz', 'linux', 'x64') > 0)
})

test('scoreAsset rejects Linux x64 asset on linux/arm64', () => {
  assert.equal(scoreAsset('llama-turboquant-linux-x64-vulkan.tar.gz', 'linux', 'arm64'), -1)
})

test('scoreAsset rejects macOS asset on linux/x64', () => {
  assert.equal(scoreAsset('llama-turboquant-macos-arm64.tar.gz', 'linux', 'x64'), -1)
})

// Linux arm64

test('scoreAsset scores Linux arm64 asset for linux/arm64', () => {
  assert.ok(scoreAsset('llama-bin-ubuntu-arm64.tar.gz', 'linux', 'arm64') > 0)
})

test('scoreAsset rejects Linux x64 asset on linux/arm64', () => {
  assert.equal(scoreAsset('llama-bin-ubuntu-x64.tar.gz', 'linux', 'arm64'), -1)
})

// Windows x64

test('scoreAsset scores Windows x64 asset for win32/x64', () => {
  assert.ok(scoreAsset('llama-server-win-x64.zip', 'win32', 'x64') > 0)
})

test('scoreAsset scores Windows asset named with windows for win32/x64', () => {
  assert.ok(scoreAsset('llama-b9608-bin-windows-x64.zip', 'win32', 'x64') > 0)
})

test('scoreAsset rejects Linux asset on win32/x64', () => {
  assert.equal(scoreAsset('llama-turboquant-linux-x64-vulkan.tar.gz', 'win32', 'x64'), -1)
})

test('scoreAsset rejects macOS asset on win32/x64', () => {
  assert.equal(scoreAsset('llama-turboquant-macos-arm64.tar.gz', 'win32', 'x64'), -1)
})

// Archive format preference

test('scoreAsset scores tar.gz higher than zip for same platform/arch', () => {
  const tarScore = scoreAsset('llama-turboquant-macos-arm64.tar.gz', 'darwin', 'arm64')
  const zipScore = scoreAsset('llama-turboquant-macos-arm64.zip', 'darwin', 'arm64')
  assert.ok(tarScore > zipScore, `tar.gz (${tarScore}) should outrank zip (${zipScore})`)
})

// Named arch preference

test('scoreAsset scores named arch higher than unnamed arch', () => {
  const named = scoreAsset('llama-turboquant-macos-arm64.tar.gz', 'darwin', 'arm64')
  const unnamed = scoreAsset('llama-turboquant-macos.tar.gz', 'darwin', 'arm64')
  assert.ok(named > unnamed, `named arch (${named}) should outrank unnamed (${unnamed})`)
})

// ─── pickReleaseAsset ─────────────────────────────────────────────────────────

test('pickReleaseAsset returns null for an empty asset list', () => {
  assert.equal(pickReleaseAsset([], 'darwin', 'arm64'), null)
})

test('pickReleaseAsset returns null when no asset matches the platform', () => {
  const assets = [
    asset('llama-linux-x64.tar.gz'),
    asset('llama-win-x64.zip'),
  ]
  assert.equal(pickReleaseAsset(assets, 'darwin', 'arm64'), null)
})

test('pickReleaseAsset returns the matching macOS asset from a mixed list', () => {
  const assets = [
    asset('llama-linux-x64-vulkan.tar.gz'),
    asset('llama-macos-arm64.tar.gz'),
    asset('llama-win-x64.zip'),
    asset('checksums.sha256'),
  ]
  const result = pickReleaseAsset(assets, 'darwin', 'arm64')
  assert.equal(result?.name, 'llama-macos-arm64.tar.gz')
})

test('pickReleaseAsset picks tar.gz over zip when both match the platform', () => {
  const assets = [
    asset('llama-macos-arm64.zip'),
    asset('llama-macos-arm64.tar.gz'),
  ]
  const result = pickReleaseAsset(assets, 'darwin', 'arm64')
  assert.equal(result?.name, 'llama-macos-arm64.tar.gz')
})

test('pickReleaseAsset returns Linux x64 asset for linux/x64', () => {
  const assets = [
    asset('llama-linux-x64-vulkan.tar.gz'),
    asset('llama-linux-x64-vulkan.zip'),
    asset('llama-macos-arm64.tar.gz'),
  ]
  const result = pickReleaseAsset(assets, 'linux', 'x64')
  assert.equal(result?.name, 'llama-linux-x64-vulkan.tar.gz')
})

test('pickReleaseAsset returns Windows asset for win32/x64', () => {
  const assets = [
    asset('llama-win-x64.zip'),
    asset('llama-linux-x64.tar.gz'),
  ]
  const result = pickReleaseAsset(assets, 'win32', 'x64')
  assert.equal(result?.name, 'llama-win-x64.zip')
})

// ─── findPlatformAsset ────────────────────────────────────────────────────────
// Tests the per-platform release-scan: forks publish one OS per tag, so the
// newest tag may have no asset for the current OS. findPlatformAsset scans the
// full list and picks the first release with a matching asset.

/** Minimal fetch stub returning a JSON body. */
function fakeFetch(body: unknown, status = 200): typeof fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response
}

test('findPlatformAsset picks macOS asset from older release when newest release is Linux-only', async () => {
  const releases = [
    // Newest: Linux only (no macOS asset)
    { tag_name: 'turboquant-linux-x64-v2', assets: [asset('llama-turboquant-linux-x64-vulkan.tar.gz')] },
    // Older: macOS arm64
    { tag_name: 'turboquant-macos-arm64-v1', assets: [asset('llama-turboquant-macos-arm64.tar.gz')] },
  ]
  const result = await findPlatformAsset('owner/repo', fakeFetch(releases), 'darwin', 'arm64')
  assert.equal(result.name, 'llama-turboquant-macos-arm64.tar.gz')
})

test('findPlatformAsset picks Linux asset from newest release when it is Linux-specific', async () => {
  const releases = [
    { tag_name: 'turboquant-linux-x64-v2', assets: [asset('llama-turboquant-linux-x64-vulkan.tar.gz')] },
    { tag_name: 'turboquant-macos-arm64-v1', assets: [asset('llama-turboquant-macos-arm64.tar.gz')] },
  ]
  const result = await findPlatformAsset('owner/repo', fakeFetch(releases), 'linux', 'x64')
  assert.equal(result.name, 'llama-turboquant-linux-x64-vulkan.tar.gz')
})

test('findPlatformAsset picks from a cross-platform release when all platforms are in one tag', async () => {
  const releases = [
    {
      tag_name: 'v1.0.0',
      assets: [
        asset('llama-macos-arm64.tar.gz'),
        asset('llama-linux-x64.tar.gz'),
        asset('llama-win-x64.zip'),
      ],
    },
  ]
  const mac = await findPlatformAsset('owner/repo', fakeFetch(releases), 'darwin', 'arm64')
  assert.equal(mac.name, 'llama-macos-arm64.tar.gz')

  const lin = await findPlatformAsset('owner/repo', fakeFetch(releases), 'linux', 'x64')
  assert.equal(lin.name, 'llama-linux-x64.tar.gz')

  const win = await findPlatformAsset('owner/repo', fakeFetch(releases), 'win32', 'x64')
  assert.equal(win.name, 'llama-win-x64.zip')
})

test('findPlatformAsset skips empty-asset releases before finding a match', async () => {
  const releases = [
    { tag_name: 'empty-v3', assets: [] },
    { tag_name: 'no-match-v2', assets: [asset('llama-linux-x64.tar.gz')] },
    { tag_name: 'macos-v1', assets: [asset('llama-macos-arm64.tar.gz')] },
  ]
  const result = await findPlatformAsset('owner/repo', fakeFetch(releases), 'darwin', 'arm64')
  assert.equal(result.name, 'llama-macos-arm64.tar.gz')
})

test('findPlatformAsset throws no_release_asset when no release matches the platform', async () => {
  const releases = [
    { tag_name: 'linux-only', assets: [asset('llama-linux-x64.tar.gz')] },
  ]
  await assert.rejects(
    () => findPlatformAsset('owner/repo', fakeFetch(releases), 'darwin', 'arm64'),
    (err: Error) => err.message === 'no_release_asset',
  )
})

test('findPlatformAsset throws no_release_asset when release list is empty', async () => {
  await assert.rejects(
    () => findPlatformAsset('owner/repo', fakeFetch([]), 'darwin', 'arm64'),
    (err: Error) => err.message === 'no_release_asset',
  )
})

test('findPlatformAsset throws with HTTP status when GitHub API fails', async () => {
  await assert.rejects(
    () => findPlatformAsset('owner/repo', fakeFetch(null, 404), 'darwin', 'arm64'),
    (err: Error) => err.message.includes('HTTP 404'),
  )
})
