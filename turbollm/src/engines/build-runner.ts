// In-app 1-click compile-from-source (ADR-100, Windows + CUDA). Runs git clone → cmake
// configure → cmake build inside the daemon, streaming each line to a {@link BuildState}
// so the UI shows live progress, then hands the built binary to the registry.
//
// Generator choice matters (ADR-100 follow-up). The default "Visual Studio" generator needs
// the CUDA *Visual Studio integration* (.props) that only the full CUDA installer adds — a
// standalone / conda CUDA Toolkit doesn't have it, so the VS generator fails with "No CUDA
// toolset found". We instead build with **Ninja** (or NMake as a no-extra-install fallback)
// *inside the MSVC developer environment* (vcvars): that generator drives `nvcc` directly off
// PATH (no VS integration needed) and is much faster. vcvars is required because Ninja/NMake —
// unlike the VS generator — don't auto-find cl.exe; vcvars puts cl/ml64/INCLUDE/LIB on PATH.
//
// The toolchain PATH override (build-prereqs.ts `buildEnv`) is applied so a conda-env /
// custom-path CUDA Toolkit (and a user-provided ninja) are found. Windows + CUDA only.
import { execFile, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { buildEnv, checkBuildPrereqs } from './build-prereqs'
import { resolveServerBinary } from './scan'
import type { BuildPhase } from './build-state'

const execFileP = promisify(execFile)

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

/** PURE: prefer Ninja (fast, parallel) when a ninja.exe is reachable; else NMake Makefiles
 *  (ships with the MSVC Build Tools — always available after vcvars, just single-threaded). */
export function pickGenerator(hasNinja: boolean): 'Ninja' | 'NMake Makefiles' {
  return hasNinja ? 'Ninja' : 'NMake Makefiles'
}

/** The cmake CUDA flags (single-config generators honor CMAKE_BUILD_TYPE). */
export const CMAKE_CONFIGURE_ARGS = ['-DGGML_CUDA=ON', '-DCMAKE_BUILD_TYPE=Release']

/** PURE: a Windows .bat that enters the MSVC dev env (vcvars x64) then runs one cmake step.
 *  All paths are quoted (vcvars/src/build dirs can contain spaces); the cmake exit code is
 *  propagated so a non-zero build fails the step. `cmakeArgs` is the full cmake argv. */
export function vcvarsBatch(vcvars: string, cmakeArgs: string[]): string {
  const quoted = cmakeArgs.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ')
  return [
    '@echo off',
    `call "${vcvars}" x64`,
    'if errorlevel 1 exit /b 1',
    `cmake ${quoted}`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n')
}

/** True if `exe` is reachable from any directory on the env's PATH. */
function onPath(env: NodeJS.ProcessEnv, exe: string): boolean {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  return (env[key] ?? '')
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        return existsSync(join(dir, exe))
      } catch {
        return false
      }
    })
}

/** CUDA runtime DLLs a llama.cpp CUDA build links against at runtime. A SOURCE build does
 *  NOT bundle these (unlike the prebuilt release zips), so the produced exe can't start —
 *  and our probe (`--version`) fails — unless they sit beside it or on PATH. We copy them
 *  next to the exe so the engine is self-contained + portable (works even after the CUDA
 *  toolkit dir is removed). Versioned names (e.g. cudart64_13.dll) → match by prefix. */
const CUDA_RUNTIME_DLL_PREFIXES = ['cudart64_', 'cublas64_', 'cublaslt64_', 'nvrtc64_', 'nvrtc-builtins64_', 'nvjitlink_']

/** Find the directories that hold the CUDA toolkit's runtime DLLs, version-matched to the
 *  build by anchoring on the toolkit that owns `nvcc` (NOT a stray cudart from an unrelated
 *  app on PATH — e.g. a PyTorch install, which would bundle the wrong version). CUDA 13 ships
 *  the runtime DLLs in `<bin>\x64`; CUDA 12 in `<bin>` itself, so we return both when present.
 *  The build already required nvcc on PATH, so it is found here by construction. */
function cudaDllSourceDirs(env: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  const pathDirs = (env[key] ?? '').split(delimiter).filter(Boolean)
  const nvccDir = pathDirs.find((dir) => {
    try {
      return existsSync(join(dir, 'nvcc.exe'))
    } catch {
      return false
    }
  })
  if (!nvccDir) return []
  return [nvccDir, join(nvccDir, 'x64')].filter((d) => {
    try {
      return existsSync(d)
    } catch {
      return false
    }
  })
}

/** Copy the CUDA runtime DLLs from the build's CUDA toolkit into `destDir`, so the produced
 *  exe is self-contained (a source build doesn't bundle them, unlike the prebuilt release
 *  zips). Each DLL name is copied at most once (first/toolkit source wins). Returns the count. */
function copyCudaRuntimeDlls(env: NodeJS.ProcessEnv, destDir: string, log: (l: string) => void): number {
  const sources = cudaDllSourceDirs(env)
  if (sources.length === 0) {
    log('Note: could not find the CUDA toolkit DLLs to bundle — the engine may need the CUDA bin on PATH to run.')
    return 0
  }
  const seen = new Set<string>()
  let copied = 0
  for (const dir of sources) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const lower = name.toLowerCase()
      if (!lower.endsWith('.dll')) continue
      if (seen.has(lower)) continue
      if (!CUDA_RUNTIME_DLL_PREFIXES.some((p) => lower.startsWith(p))) continue
      try {
        copyFileSync(join(dir, name), join(destDir, name))
        seen.add(lower)
        copied++
      } catch {
        /* skip a locked/unreadable DLL — best effort */
      }
    }
  }
  if (copied > 0) log(`Bundled ${copied} CUDA runtime DLL(s) next to the binary so the engine is self-contained.`)
  return copied
}

/** Locate vcvarsall.bat via vswhere (ships with VS / Build Tools). Returns null if VS with
 *  the C++ tools isn't installed or vswhere can't find it. */
async function findVcvarsall(): Promise<string | null> {
  try {
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    const { stdout } = await execFileP(
      vswhere,
      ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-find', 'VC\\Auxiliary\\Build\\vcvarsall.bat'],
      { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
    )
    const p = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    return p && existsSync(p) ? p : null
  } catch {
    return null
  }
}

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
  // Force git to FAIL fast instead of blocking on an interactive credential prompt (a
  // private/typo'd URL would otherwise hang the build with stdin ignored). GCM_INTERACTIVE
  // disables the Git Credential Manager GUI on Windows.
  const env = { ...buildEnv(req.toolchainDirs), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }

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
  // We compile with Ninja/NMake (not the VS generator), so we need the MSVC dev env.
  const vcvars = await findVcvarsall()
  if (!vcvars) {
    throw new Error(
      'Could not locate the Visual Studio C++ build environment (vcvarsall.bat). Install the ' +
        '"Desktop development with C++" workload from the Visual Studio Build Tools.',
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

  // Pick the generator from what's reachable on PATH (incl. the user's toolchain dirs).
  const generator = pickGenerator(onPath(env, 'ninja.exe'))
  hooks.log(
    generator === 'Ninja'
      ? 'Using the Ninja generator (drives nvcc directly — no Visual Studio CUDA integration needed).'
      : 'Ninja not found on PATH — using the NMake generator (works, but single-threaded and slower; ' +
          'add a folder containing ninja.exe under Build environment for much faster builds).',
  )

  // 2) Configure — inside the MSVC dev env so cl/ml64/INCLUDE/LIB are set; nvcc comes off PATH.
  hooks.phase('configuring')
  const configureBat = join(buildRoot, '_tllm_configure.bat')
  writeFileSync(configureBat, vcvarsBatch(vcvars, ['-G', generator, '-B', buildSubdir, '-S', srcDir, ...CMAKE_CONFIGURE_ARGS]))
  await runStep('cmd.exe', ['/c', configureBat], { cwd: buildRoot, env, signal, onLine: hooks.log })

  // 3) Compile just the server target (Ninja parallelizes with -j; NMake ignores it).
  hooks.phase('compiling')
  const compileBat = join(buildRoot, '_tllm_build.bat')
  writeFileSync(compileBat, vcvarsBatch(vcvars, ['--build', buildSubdir, '-j', '--target', 'llama-server']))
  await runStep('cmd.exe', ['/c', compileBat], { cwd: buildRoot, env, signal, onLine: hooks.log })

  // 4) Locate the produced binary (Ninja: build/bin/llama-server.exe; layouts vary).
  hooks.phase('registering')
  const binPath = resolveServerBinary(buildSubdir) ?? resolveServerBinary(buildRoot)
  if (!binPath) {
    throw new Error('Build finished but no llama-server binary was found in the output — see the log above.')
  }
  // Make the engine self-contained: a source build doesn't bundle the CUDA runtime DLLs, so
  // copy them next to the exe (else the probe + every launch fail to start with missing DLLs).
  copyCudaRuntimeDlls(env, dirname(binPath), hooks.log)
  return { binPath, commit, buildRoot }
}
