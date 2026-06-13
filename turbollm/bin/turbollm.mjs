#!/usr/bin/env node
// Hand-written launcher shim — NOT bundled by tsup. It runs before the bundled
// daemon (dist/cli.js) loads, so it can do two things that must happen before
// node:sqlite is imported (the bundle hoists that import, emitting an experimental
// warning that PowerShell renders as a scary red error block on every run):
//   1. Guard the Node version with a friendly message (node:sqlite needs Node 22+).
//   2. Register a 'warning' filter that swallows the node:sqlite experimental notice
//      while still printing every other warning.
// Then it hands off to the real CLI via dynamic import (same process; argv intact).
const major = Number(process.versions.node.split('.')[0])
if (major < 22) {
  process.stderr.write(
    `TurboLLM requires Node.js 22 or newer.\n` +
      `You are running Node.js ${process.versions.node}.\n` +
      `Please upgrade: https://nodejs.org\n`,
  )
  process.exit(1)
}

process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return
  process.stderr.write(`${w.stack ?? `${w.name}: ${w.message}`}\n`)
})

await import('../dist/cli.js')
