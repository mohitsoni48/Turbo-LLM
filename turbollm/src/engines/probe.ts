// Engine probe (spec 03 §3): run <bin> --version and --help to capture the
// version + a capability fingerprint. Ports the verified Go probe.
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ProbeResult {
  version: string
  capabilities: { kvTypes: string[]; flags: string[] }
}

export class ProbeError extends Error {
  constructor(
    public code: string,
    msg: string,
  ) {
    super(msg)
    this.name = 'ProbeError'
  }
}

const RE_VERSION = /^\s*version:\s*(.+?)\s*$/im
const RE_FLAG = /--[a-z0-9][a-z0-9-]+/g
const KNOWN_KV = ['f16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'q8_1']

function runCaptured(bin: string, arg: string): Promise<{ out: string; err: Error | null }> {
  return new Promise((resolve) => {
    execFile(bin, [arg], { cwd: dirname(bin), timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ out: (stdout || '') + (stderr || ''), err: error })
    })
  })
}

export async function probe(bin: string): Promise<ProbeResult> {
  if (!existsSync(bin) || statSync(bin).isDirectory()) {
    throw new ProbeError('binary_not_found', 'Binary not found at that path.')
  }
  const v = await runCaptured(bin, '--version')
  const h = await runCaptured(bin, '--help')
  if (v.err && h.err) {
    let msg = 'Could not run the binary (--version and --help both failed).'
    const tail = lastLine(v.out)
    if (tail) msg += ' ' + tail
    throw new ProbeError('probe_failed', msg)
  }

  const combined = v.out + '\n' + h.out
  const m = RE_VERSION.exec(combined)
  let version = m ? m[1].trim() : trimLen(firstNonEmptyLine(v.out), 100)
  if (!version) version = 'unknown'

  const flags = [...new Set(h.out.match(RE_FLAG) ?? [])].sort()
  const kvTypes = flags.includes('--cache-type-k') ? [...KNOWN_KV] : ['f16']
  if (combined.toLowerCase().includes('turbo')) kvTypes.push('turbo2', 'turbo3', 'turbo4')

  return { version, capabilities: { kvTypes, flags } }
}

function firstNonEmptyLine(s: string): string {
  for (const ln of s.split('\n')) {
    const t = ln.trim()
    if (t) return t
  }
  return ''
}
function lastLine(s: string): string {
  const lines = s.trim().split('\n')
  return lines.length ? trimLen(lines[lines.length - 1].trim(), 200) : ''
}
function trimLen(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s
}
