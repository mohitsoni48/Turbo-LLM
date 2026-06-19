// `turbollm launch <cli>` — start an Anthropic-compatible coding CLI (e.g. Claude
// Code) already wired to the local TurboLLM gateway, so it uses whatever model is
// loaded here instead of a cloud API (spec 06 §6). Ships with the npm package.
//
// The daemon must already be running with a model loaded; this command is a thin
// launcher that points the CLI's ANTHROPIC_* env vars at TurboLLM and execs it.
import { spawn } from 'node:child_process'

interface CliSpec {
  bin: string
  label: string
  install: string
}

// Coding CLIs that speak the Anthropic /v1/messages API (what our gateway serves).
const SUPPORTED: Record<string, CliSpec> = {
  claude: { bin: 'claude', label: 'Claude Code', install: 'npm install -g @anthropic-ai/claude-code' },
}

interface DaemonStatus {
  engine?: { state?: string }
  model?: { name?: string }
}

// Type-safe subset of spawn's return value that launchCli actually uses.
type SpawnLike = (
  cmd: string,
  args: string[],
  opts: Parameters<typeof spawn>[2],
) => Pick<ReturnType<typeof spawn>, 'on'>

/** Launch `target` CLI wired to the TurboLLM gateway on 127.0.0.1:<port>. Returns
 *  the child's exit code (or a non-zero code on a setup failure). Pure launcher —
 *  it never starts the daemon itself.
 *
 *  `_spawn` is an optional injection point used by unit tests to capture the env
 *  passed to the child process without actually launching Claude Code. */
export async function launchCli(
  target: string,
  port: number,
  passthrough: string[],
  _spawn: SpawnLike = spawn,
): Promise<number> {
  const spec = SUPPORTED[target]
  if (!target || !spec) {
    const list = Object.keys(SUPPORTED).join(', ')
    process.stderr.write(`Usage: turbollm launch <cli>   (supported: ${list})\n`)
    return 1
  }

  const base = `http://127.0.0.1:${port}`

  // Confirm the daemon is up and a model is loaded before handing off.
  let status: DaemonStatus
  try {
    const res = await fetch(`${base}/api/v1/status`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    status = (await res.json()) as DaemonStatus
  } catch {
    process.stderr.write(
      `Could not reach TurboLLM at ${base}.\n` +
        `Start the daemon first — run \`turbollm\` in another terminal — or pass --port if it runs elsewhere.\n`,
    )
    return 1
  }

  if (status.engine?.state !== 'running' || !status.model?.name) {
    process.stderr.write(
      `TurboLLM is running, but no model is loaded.\n` +
        `Open ${base} → Models → Load a model, then run this again.\n`,
    )
    return 1
  }
  const model = status.model.name

  process.stdout.write(`▸ Launching ${spec.label} → TurboLLM  (model: ${model}, ${base})\n`)

  const child = _spawn(spec.bin, passthrough, {
    stdio: 'inherit',
    // On Windows the CLI is usually a `.cmd`/`.ps1` shim; a shell resolves it via PATHEXT.
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: base,
      // No auth is enforced on the local gateway; the CLI just needs a non-empty token.
      ANTHROPIC_AUTH_TOKEN: 'turbollm-local',
      ANTHROPIC_MODEL: model,
      // Local LLMs are 30–120 s per response — raise Claude Code's request timeout so it
      // doesn't abort mid-generation. 300 s (5 min) covers even the slowest local model.
      // Zero retries: retrying a slow local model cold-starts it again and makes things worse.
      ANTHROPIC_TIMEOUT: '300000',
      ANTHROPIC_MAX_RETRIES: '0',
    },
  })

  return await new Promise<number>((resolve) => {
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        process.stderr.write(
          `\n${spec.label} is not installed or not on your PATH.\n` + `Install it:  ${spec.install}\n`,
        )
      } else {
        process.stderr.write(`Failed to launch ${spec.label}: ${e.message}\n`)
      }
      resolve(127)
    })
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}
