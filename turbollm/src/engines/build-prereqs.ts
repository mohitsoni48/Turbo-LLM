// Compile-from-source (Windows + CUDA) — prerequisite checker + build commands
// (ADR-089). Detects the build toolchain (git/cmake/CUDA/MSVC), tells the user what's
// missing (with install links), and the in-app 1-click build (ADR-100, build-runner.ts)
// runs the exact commands here. Linux/macOS are parked — `checkBuildPrereqs` reports
// `supported:false` off Windows.
//
// Toolchain dirs (ADR-100): the daemon inherits the system PATH, so a CUDA Toolkit /
// compiler installed in a conda env or a custom location isn't found. {@link buildEnv}
// prepends user-configured dirs to PATH for BOTH the probe below and the real build, so
// pointing at e.g. a conda env's bin makes `nvcc` resolve.
import { execFile } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** Build a child-process env with `toolchainDirs` prepended to PATH. Empty/blank dirs are
 *  dropped. PATH is matched case-insensitively (Windows uses `Path`); we write back to the
 *  same key name the parent used so we never end up with a duplicate `PATH`/`Path` pair. */
export function buildEnv(toolchainDirs: string[] = []): NodeJS.ProcessEnv {
  const dirs = toolchainDirs.map((d) => d.trim()).filter(Boolean)
  if (dirs.length === 0) return { ...process.env }
  const env = { ...process.env }
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  env[key] = [...dirs, env[key] ?? ''].filter(Boolean).join(delimiter)
  return env
}

/** One build-toolchain prerequisite (git / cmake / CUDA / MSVC). */
export interface BuildPrereqTool {
  id: 'git' | 'cmake' | 'cuda' | 'msvc'
  name: string
  found: boolean
  version?: string
  installUrl: string
}

export interface BuildPrereqs {
  /** Guided build is Windows + CUDA only for now. False on Linux/macOS (parked). */
  supported: boolean
  tools: BuildPrereqTool[]
}

const INSTALL_URLS: Record<BuildPrereqTool['id'], string> = {
  git: 'https://git-scm.com/downloads',
  cmake: 'https://cmake.org/download/',
  cuda: 'https://developer.nvidia.com/cuda-downloads',
  // The "Desktop development with C++" workload from the VS Build Tools installer.
  msvc: 'https://visualstudio.microsoft.com/downloads/',
}

/** Run a version command with a short timeout; return its trimmed stdout (or stderr —
 *  some tools, e.g. nvcc, print to stdout; vswhere to stdout too). Throws if the tool
 *  is missing or errors, which the caller turns into `found:false`. `env` carries the
 *  PATH override (ADR-100) so tools in a conda env / custom dir are found. */
async function runVersion(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout, stderr } = await execFileP(cmd, args, {
    timeout: 8000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env,
  })
  return (stdout || stderr || '').trim()
}

/** Parse `git --version` → the bare version (e.g. "2.45.1"), or '' if unparseable. */
function parseGitVersion(out: string): string {
  // Windows git reports "git version 2.52.0.windows.1" — take only the numeric release.
  const m = out.match(/git version\s+(\d+(?:\.\d+)*)/i)
  return m ? m[1] : ''
}

/** Parse `cmake --version` → the bare version (e.g. "3.30.2"), or '' if unparseable. */
function parseCmakeVersion(out: string): string {
  const m = out.match(/cmake version\s+([\d.]+)/i)
  return m ? m[1] : ''
}

/** Parse `nvcc --version` → the CUDA release version (e.g. "12.6"), or '' if unparseable. */
function parseNvccVersion(out: string): string {
  // e.g. "Cuda compilation tools, release 12.6, V12.6.20"
  const m = out.match(/release\s+([\d.]+)/i)
  return m ? m[1] : ''
}

async function checkGit(env: NodeJS.ProcessEnv): Promise<BuildPrereqTool> {
  let found = false
  let version: string | undefined
  try {
    version = parseGitVersion(await runVersion('git', ['--version'], env)) || undefined
    found = true
  } catch {
    found = false
  }
  return { id: 'git', name: 'Git', found, version, installUrl: INSTALL_URLS.git }
}

async function checkCmake(env: NodeJS.ProcessEnv): Promise<BuildPrereqTool> {
  let found = false
  let version: string | undefined
  try {
    version = parseCmakeVersion(await runVersion('cmake', ['--version'], env)) || undefined
    found = true
  } catch {
    found = false
  }
  return { id: 'cmake', name: 'CMake', found, version, installUrl: INSTALL_URLS.cmake }
}

async function checkCuda(env: NodeJS.ProcessEnv): Promise<BuildPrereqTool> {
  let found = false
  let version: string | undefined
  try {
    version = parseNvccVersion(await runVersion('nvcc', ['--version'], env)) || undefined
    found = true
  } catch {
    found = false
  }
  return { id: 'cuda', name: 'CUDA Toolkit', found, version, installUrl: INSTALL_URLS.cuda }
}

/** Detect the MSVC C++ Build Tools via vswhere.exe (ships with VS / Build Tools). We ask
 *  it for the latest install that has the C++ x64/x86 tools component and return its
 *  installationVersion. A missing component (no version printed) or a missing vswhere →
 *  not found. */
async function checkMsvc(env: NodeJS.ProcessEnv): Promise<BuildPrereqTool> {
  let found = false
  let version: string | undefined
  try {
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    const out = await runVersion(vswhere, [
      '-latest',
      '-products', '*',
      '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property', 'installationVersion',
    ], env)
    version = out.split(/\r?\n/)[0]?.trim() || undefined
    found = !!version
  } catch {
    found = false
  }
  return {
    id: 'msvc',
    name: 'Visual Studio C++ Build Tools',
    found,
    version,
    installUrl: INSTALL_URLS.msvc,
  }
}

/** Detect the Windows + CUDA build toolchain. On non-Windows the guided build is parked,
 *  so this returns `{ supported:false, tools:[] }` without probing anything. `toolchainDirs`
 *  (ADR-100) are prepended to PATH so a conda-env / custom-path CUDA Toolkit is detected. */
export async function checkBuildPrereqs(toolchainDirs: string[] = []): Promise<BuildPrereqs> {
  if (process.platform !== 'win32') {
    return { supported: false, tools: [] }
  }
  const env = buildEnv(toolchainDirs)
  const tools = await Promise.all([checkGit(env), checkCmake(env), checkCuda(env), checkMsvc(env)])
  return { supported: true, tools }
}

/** PURE: the exact Windows + CUDA build command list for `repoUrl` (optional `branch`).
 *  Used by the guide's copy-able command block. The trailing comment notes where the
 *  binary lands so the user knows what to point "Add your own engine" at. */
export function buildCommands(repoUrl: string, branch?: string): string[] {
  const b = (branch ?? '').trim()
  // Quote the branch + URL so the copy-pasted command survives a space/special char
  // in either (display-only; values come from the catalog, but the user pastes this).
  const clone = b
    ? `git clone --branch "${b}" --depth 1 "${repoUrl}" turbo-build`
    : `git clone --depth 1 "${repoUrl}" turbo-build`
  return [
    clone,
    'cd turbo-build',
    'cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release',
    'cmake --build build --config Release -j --target llama-server',
    '# Built binary: build\\bin\\Release\\llama-server.exe — add it via "Add your own engine".',
  ]
}
