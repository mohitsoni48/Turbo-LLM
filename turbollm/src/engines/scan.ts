// Guided "Add your own engine" scan (engine overhaul, Phase 3). Given a folder OR
// a binary file, locate the server binary and report what we found. Read-only —
// registration still goes through the registry. Factored out of the route so the
// resolution logic is unit-testable without HTTP.
import { basename, dirname } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { findFile } from './download'

/** The server binary name for the daemon's OS — same convention as download.ts. */
export const serverBinName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'

/** Dirs we never descend into during a scan: VCS/dep/dotdirs would make a big tree
 *  hang and never hold an engine binary anyway. */
function skipScanDir(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name.startsWith('.')
}

/** Locate the server binary for a chosen path. If `path` is a file, it's taken as
 *  the binary directly; if a directory, we walk it (pruned) for `serverBinName`.
 *  Returns null when nothing usable is found. */
export function resolveServerBinary(path: string, binName = serverBinName): string | null {
  if (!existsSync(path)) return null
  let isDir: boolean
  try {
    isDir = statSync(path).isDirectory()
  } catch {
    return null
  }
  if (!isDir) return path
  return findFile(path, binName, skipScanDir)
}

/** A suggested engine name from the binary's location: the folder the binary lives
 *  in, plus the probed version when known (e.g. "turboquant (b1234)"). Falls back to
 *  just the folder name when the version is unknown/empty. */
export function suggestEngineName(binPath: string, version: string): string {
  const folder = basename(dirname(binPath))
  const v = version.trim()
  return v && v.toLowerCase() !== 'unknown' ? `${folder} (${v})` : folder
}
