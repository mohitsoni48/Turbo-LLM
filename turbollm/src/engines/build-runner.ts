// In-app 1-click compile-from-source (ADR-100, Windows + CUDA). Runs the same commands
// the guide shows (git clone → cmake configure → cmake build llama-server) inside the
// daemon, streaming each line to a {@link BuildState} so the UI can show live progress,
// then hands the built binary to the registry. The toolchain PATH override (ADR-100,
// build-prereqs.ts `buildEnv`) is applied so a conda-env / custom-path CUDA Toolkit and
// compiler are found by both `cmake`'s detection and `nvcc`.
//
// Scope mirrors the guide: Windows + CUDA only (the caller gates on `checkBuildPrereqs`).
// We never run the build off Windows.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildEnv, checkBuildPrereqs } from './build-prereqs'
import { resolveServerBinary } from './scan'
import type { BuildPhase } from './build-state'

export interface BuildRequest {
  repoUrl: string
  branch?: string
  /** `<dataDir>/engines` — builds live under `<enginesRoot>/build/<slug>/`. */
  enginesRoot: string
  /** Dirs prepended to PATH for the build (ADR-100). */
  toolchainDirs: string[]
}

export interface BuildHooks {
  phase: (p: BuildPhase) => void
  log: (line: string) => void
}

export interface BuildOutput {
  /** Absolute path to the compiled `llama-server[.exe]`. */
  binPath: string
  /** The exact commit that was built (HEAD of the cloned shallow checkout). */
  commit: string
  /** Directory the build lives in (so the caller can GC on failure if desired). */
  buildRoot: string
}

/** PURE: a filesystem-safe directory slug for a repo+branch, so a rebuild of the same
 *  source reuses (overwrites) the same dir. e.g. ("https://github.com/ikawrakow/ik_llama.cpp.git",
 *  "sidestream") → "ik_llama.cpp-sidestream". Falls back to "engine" for an unparseable URL. */
export function buildDirName(repoUrl: string, branch?: string): string {
  const last = repoUrl.trim().replace(/\/+$/, '').split(/[\\/]/).pop() ?? ''
  const repo = last.replace(/\.git$/i, '').trim() || 'engine'
  const b = (branch ?? '').trim()
  const raw = b ? `${repo}-${b}` : repo
  // Keep it tame on disk: collapse anything outside [A-Za-z0-9._-] to a single dash.
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'engine'
}

/** The cmake configure args (Windows + CUDA). Kept here so the runner and any test agree. */
export const CMAKE_CONFIGURE_ARGS = ['-DGGML_CUDA=ON', '-DCMAKE_BUILD_TYPE=Release']

/** Run one child process, streaming combined stdout+stderr line-by-line to `onLine` and
 *  resolving with the full stdout text. Rejects with a clear message on a non-zero exit or
 *  spawn error; aborting `signal` kills the child (Node throws AbortError, name preserved). */
function runStep(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; signal: AbortSignal; onLine: (line: string) => void },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let outBuf = ''
    let errBuf = ''
    const pump = (chunk: string, isErr: boolean) => {
      if (!isErr) stdout += chunk
      let buf = isErr ? errBuf + chunk : outBuf + chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        opts.onLine(buf.slice(0, nl).replace(/\r$/, ''))
        buf = buf.slice(nl + 1)
      }
      if (isErr) errBuf = buf
      else outBuf = buf
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => pump(c, false))
    child.stderr.on('data', (c: string) => pump(c, true))
    child.on('error', (e) => reject(e)) // includes AbortError when signal fires
    child.on('close', (code) => {
      if (outBuf) opts.onLine(outBuf.replace(/\r$/, ''))
      if (errBuf) opts.onLine(errBuf.replace(/\r$/, ''))
      if (code === 0) resolve(stdout)
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
  })
}

/** Run the full clone → configure → compile → locate flow. Throws on any failure (the
 *  caller surfaces it via BuildState.fail); on success returns the built binary + commit. */
export async function runBuild(req: BuildRequest, hooks: BuildHooks, signal: AbortSignal): Promise<BuildOutput> {
  const env = buildEnv(req.toolchainDirs)

  // Fail fast with actionable guidance if the toolchain isn't usable, rather than a deep
  // cryptic cmake error. CUDA is required because we build with -DGGML_CUDA=ON.
  hooks.phase('preparing')
  const prereqs = await checkBuildPrereqs(req.toolchainDirs)
  if (!prereqs.supported) throw new Error('In-app build is currently Windows + CUDA only.')
  const missing = prereqs.tools.filter((t) => (t.id === 'git' || t.id === 'cmake' || t.id === 'cuda') && !t.found)
  if (missing.length > 0) {
    const names = missing.map((t) => t.name).join(', ')
    throw new Error(
      `Missing build prerequisite(s): ${names}. Install them, or — if they live in a conda env / custom path — ` +
        `add that folder under Build environment so TurboLLM can find them.`,
    )
  }

  const buildRoot = join(req.enginesRoot, 'build', buildDirName(req.repoUrl, req.branch))
  const srcDir = join(buildRoot, 'src')
  const buildSubdir = join(buildRoot, 'build')
  // Start clean so a rebuild never mixes old + new objects.
  rmSync(buildRoot, { recursive: true, force: true })
  mkdirSync(buildRoot, { recursive: true })

  // 1) Shallow clone.
  hooks.phase('cloning')
  const cloneArgs = ['clone', '--depth', '1']
  if ((req.branch ?? '').trim()) cloneArgs.push('--branch', req.branch!.trim())
  cloneArgs.push(req.repoUrl, srcDir)
  await runStep('git', cloneArgs, { env, signal, onLine: hooks.log })

  // Record the built commit (ADR-088 provenance / rebuild comparison).
  const commit = (await runStep('git', ['-C', srcDir, 'rev-parse', 'HEAD'], { env, signal, onLine: () => {} })).trim()

  // 2) Configure.
  hooks.phase('configuring')
  await runStep('cmake', ['-B', buildSubdir, '-S', srcDir, ...CMAKE_CONFIGURE_ARGS], {
    env,
    signal,
    onLine: hooks.log,
  })

  // 3) Compile just the server target.
  hooks.phase('compiling')
  await runStep('cmake', ['--build', buildSubdir, '--config', 'Release', '-j', '--target', 'llama-server'], {
    env,
    signal,
    onLine: hooks.log,
  })

  // 4) Locate the produced binary (MSVC: build/bin/Release/llama-server.exe; others vary).
  hooks.phase('registering')
  const binPath = resolveServerBinary(buildSubdir) ?? resolveServerBinary(buildRoot)
  if (!binPath) {
    throw new Error('Build finished but no llama-server binary was found in the output — see the log above.')
  }
  return { binPath, commit, buildRoot }
}
