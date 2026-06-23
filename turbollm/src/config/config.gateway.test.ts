// Gateway config tests (F-032 kvCacheTtlMs default + normalization). Covers:
//   • defaultConfig() seeds gateway.kvCacheTtlMs = 300_000 (and keepN 1 / autoSwap on).
//   • loading a config WITHOUT the field backfills the 300_000 default (pre-F-032 files).
//   • a valid persisted value round-trips; garbage/negative falls back to the default.
//   • 0 is honored (disables the sweep) — distinct from "absent".
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore, defaultConfig } from './config'

/** Write a config.json into a throwaway dir and load it, returning the loaded snapshot. */
function loadWith(raw: Record<string, unknown>): ReturnType<ConfigStore['snapshot']> {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-cfg-'))
  try {
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify(raw))
    return ConfigStore.load(path).snapshot()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('defaultConfig seeds gateway.kvCacheTtlMs = 300_000', () => {
  const d = defaultConfig()
  assert.equal(d.gateway.kvCacheTtlMs, 300_000)
  assert.equal(d.gateway.keepN, 1)
  assert.equal(d.gateway.autoSwap, true)
})

test('a pre-F-032 config (gateway without kvCacheTtlMs) backfills the 300_000 default', () => {
  const snap = loadWith({ version: 2, gateway: { autoSwap: true, keepN: 2 } })
  assert.equal(snap.gateway.kvCacheTtlMs, 300_000)
  assert.equal(snap.gateway.keepN, 2, 'other gateway fields are preserved')
})

test('a valid persisted kvCacheTtlMs round-trips; 0 disables and is honored', () => {
  assert.equal(loadWith({ version: 2, gateway: { kvCacheTtlMs: 120_000 } }).gateway.kvCacheTtlMs, 120_000)
  assert.equal(loadWith({ version: 2, gateway: { kvCacheTtlMs: 0 } }).gateway.kvCacheTtlMs, 0, '0 = sweep disabled')
})

test('garbage or negative kvCacheTtlMs falls back to the 300_000 default', () => {
  assert.equal(loadWith({ version: 2, gateway: { kvCacheTtlMs: -1 } }).gateway.kvCacheTtlMs, 300_000)
  assert.equal(loadWith({ version: 2, gateway: { kvCacheTtlMs: 'soon' } }).gateway.kvCacheTtlMs, 300_000)
  assert.equal(loadWith({ version: 2, gateway: { kvCacheTtlMs: Infinity } }).gateway.kvCacheTtlMs, 300_000)
})
