// Unit tests for daemon-pid.ts (F-035): pidfile read/write/remove and stopDaemon.
// All OS interactions are injected via hooks so no real processes are touched.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writePidfile,
  readPidfile,
  removePidfile,
  stopDaemon,
  type StopHooks,
} from './daemon-pid.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-pid-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Fake StopHooks where the target process starts alive and we can flip it.
 *  Returns the same object for both reading state (`hooks.alive`, `hooks.taskkillCalled`)
 *  and satisfying the StopHooks interface, so mutations are visible on the returned ref. */
function makeHooks(alive = true): StopHooks & { alive: boolean; signals: string[]; taskkillCalled: boolean } {
  const hooks = {
    alive,
    signals: [] as string[],
    taskkillCalled: false,
    processExists(_pid: number) { return hooks.alive },
    kill(_pid: number, signal: NodeJS.Signals) {
      hooks.signals.push(signal)
      // Simulate SIGTERM causing exit after one poll cycle.
      if (signal === 'SIGTERM') hooks.alive = false
    },
    taskkill(_pid: number) {
      hooks.taskkillCalled = true
      hooks.alive = false
    },
  }
  return hooks
}

// ── writePidfile / readPidfile / removePidfile ────────────────────────────────

test('writePidfile + readPidfile round-trips pid and port', () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, 12345, 6996)
    const data = readPidfile(dir)
    assert.deepEqual(data, { pid: 12345, port: 6996 })
  } finally {
    cleanup()
  }
})

test('readPidfile returns null when file is absent', () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    assert.equal(readPidfile(dir), null)
  } finally {
    cleanup()
  }
})

test('readPidfile returns null for invalid JSON', () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    writeFileSync(join(dir, 'daemon.pid'), 'not-json')
    assert.equal(readPidfile(dir), null)
  } finally {
    cleanup()
  }
})

test('removePidfile deletes the file', () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, 1, 1)
    removePidfile(dir)
    assert.equal(readPidfile(dir), null)
  } finally {
    cleanup()
  }
})

test('removePidfile is silent when file does not exist', () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    // Should not throw
    removePidfile(dir)
  } finally {
    cleanup()
  }
})

// ── stopDaemon ────────────────────────────────────────────────────────────────

test('stopDaemon returns friendly message when no pidfile exists', async () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    const hooks = makeHooks(false)
    const result = await stopDaemon(dir, hooks)
    assert.equal(result.stopped, false)
    assert.match(result.message, /No running TurboLLM daemon found/)
  } finally {
    cleanup()
  }
})

test('stopDaemon returns friendly message when pidfile exists but process is gone', async () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, 99999, 6996)
    const hooks = makeHooks(false) // process already dead
    const result = await stopDaemon(dir, hooks)
    assert.equal(result.stopped, false)
    assert.match(result.message, /No running TurboLLM daemon found/)
    // Pidfile should have been cleaned up
    assert.equal(readPidfile(dir), null)
  } finally {
    cleanup()
  }
})

test('stopDaemon on Unix sends SIGTERM and reports success', async () => {
  // Only run on non-Windows to test the Unix path directly.
  if (process.platform === 'win32') return

  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, 42, 7000)
    const hooks = makeHooks(true)
    const result = await stopDaemon(dir, hooks)
    assert.equal(result.stopped, true)
    assert.equal(result.port, 7000)
    assert.match(result.message, /TurboLLM daemon stopped/)
    assert.ok(hooks.signals.includes('SIGTERM'), 'SIGTERM should have been sent')
    // Pidfile should be removed
    assert.equal(readPidfile(dir), null)
  } finally {
    cleanup()
  }
})

test('stopDaemon on Windows calls taskkill and reports success', async () => {
  // Simulate the Windows code path regardless of actual platform by stubbing
  // process.platform. We do this via a hook-level assertion — the Windows
  // branch is selected by process.platform inside stopDaemon; so we patch it.
  // Instead, we test the Windows branch by calling with a hook that asserts
  // taskkill is invoked when the daemon is alive. We can only truly exercise
  // the Windows branch on Windows, so guard the platform check.
  if (process.platform !== 'win32') {
    // On non-Windows, verify that the hooks.taskkill is NOT called (Unix path used).
    const { dir, cleanup } = makeTmpDir()
    try {
      writePidfile(dir, 42, 7000)
      const hooks = makeHooks(true)
      await stopDaemon(dir, hooks)
      assert.equal(hooks.taskkillCalled, false, 'taskkill should not be called on Unix')
    } finally {
      cleanup()
    }
    return
  }

  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, 42, 7000)
    const hooks = makeHooks(true)
    const result = await stopDaemon(dir, hooks)
    assert.equal(result.stopped, true)
    assert.equal(hooks.taskkillCalled, true, 'taskkill should be called on Windows')
    assert.equal(readPidfile(dir), null)
  } finally {
    cleanup()
  }
})
