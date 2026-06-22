import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { stripMacOsQuarantine } from './download.js'

describe('stripMacOsQuarantine', () => {
  test('is a no-op and does not throw on non-darwin platforms', () => {
    if (process.platform === 'darwin') return
    const tmp = mkdtempSync(join(tmpdir(), 'turbollm-quarantine-test-'))
    try {
      assert.doesNotThrow(() => stripMacOsQuarantine(tmp))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('removes com.apple.quarantine attribute from directory on macOS', {
    skip: process.platform !== 'darwin' ? 'macOS only' : false,
  }, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'turbollm-quarantine-test-'))
    try {
      // Simulate what macOS sets on a downloaded file
      execSync(
        `xattr -w com.apple.quarantine "0083;00000000;test;00000000-0000-0000-0000-000000000000" "${tmp}"`,
      )
      const before = execSync(`xattr -l "${tmp}"`).toString()
      assert.ok(before.includes('com.apple.quarantine'), 'precondition: quarantine attribute was not set')

      stripMacOsQuarantine(tmp)

      const after = execSync(`xattr -l "${tmp}" 2>&1 || true`).toString()
      assert.ok(!after.includes('com.apple.quarantine'), 'quarantine attribute was not removed')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('does not throw when quarantine attribute is absent on macOS', {
    skip: process.platform !== 'darwin' ? 'macOS only' : false,
  }, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'turbollm-quarantine-test-'))
    try {
      // No quarantine attribute — must not throw even though xattr -d exits non-zero
      assert.doesNotThrow(() => stripMacOsQuarantine(tmp))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('strips quarantine recursively from files inside the directory on macOS', {
    skip: process.platform !== 'darwin' ? 'macOS only' : false,
  }, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'turbollm-quarantine-test-'))
    const nested = join(tmp, 'bin')
    const nestedFile = join(nested, 'llama-server')
    try {
      mkdirSync(nested, { recursive: true })
      execSync(`touch "${nestedFile}"`)
      // Set quarantine on the nested file (simulating a bundled dylib)
      execSync(
        `xattr -w com.apple.quarantine "0083;00000000;test;00000000-0000-0000-0000-000000000000" "${nestedFile}"`,
      )

      stripMacOsQuarantine(tmp)

      const after = execSync(`xattr -l "${nestedFile}" 2>&1 || true`).toString()
      assert.ok(!after.includes('com.apple.quarantine'), 'quarantine was not stripped from nested file')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
