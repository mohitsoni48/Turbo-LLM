// `turbollm launch <cli>` — start an Anthropic-compatible coding CLI (e.g. Claude
// Code) already wired to the local TurboLLM gateway, so it uses whatever model is
// loaded here instead of a cloud API (spec 06 §6). Ships with the npm package.
//
// The daemon must already be running; this command is a thin launcher that points
// the CLI's ANTHROPIC_* env vars at TurboLLM and execs it. If no model is loaded,
// it auto-loads the last-used model (or the first available one). With --model it
// resolves and loads a specific model by key/name before launching.
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
  model?: { name?: string; key?: string } | null
  lastLoaded?: { modelKey?: string } | null
}

interface ModelEntry {
  key: string
  name: string
}

// Type-safe subset of spawn's return value that launchCli actually uses.
type SpawnLike = (
  cmd: string,
  args: string[],
  opts: Parameters<typeof spawn>[2],
) => Pick<ReturnType<typeof spawn>, 'on'>

/** Fetch the current daemon status. Returns null on network error. */
async function fetchStatus(base: string, _fetch: typeof fetch = fetch): Promise<DaemonStatus | null> {
  try {
    const res = await _fetch(`${base}/api/v1/status`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    return (await res.json()) as DaemonStatus
  } catch {
    return null
  }
}

/** Fetch the model list. Returns [] on network error. */
async function fetchModels(base: string, _fetch: typeof fetch = fetch): Promise<ModelEntry[]> {
  try {
    const res = await _fetch(`${base}/api/v1/models`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return []
    const data = (await res.json()) as { models?: ModelEntry[] }
    return data.models ?? []
  } catch {
    return []
  }
}

/**
 * Resolve a model key from a user-supplied name/key string against the library.
 * Resolution order:
 *   1. Exact key match
 *   2. Exact name match (case-sensitive)
 *   3. Case-insensitive / partial name match (first result)
 */
function resolveModelKey(models: ModelEntry[], input: string): string | null {
  // 1. Exact key match
  const byKey = models.find((m) => m.key === input)
  if (byKey) return byKey.key

  // 2. Exact name match (case-sensitive)
  const byName = models.find((m) => m.name === input)
  if (byName) return byName.key

  // 3. Case-insensitive / partial name match
  const lower = input.toLowerCase()
  const partial = models.find((m) => m.name.toLowerCase().includes(lower))
  if (partial) return partial.key

  return null
}

/**
 * POST /api/v1/engine/start with a modelKey and poll /api/v1/status until the
 * engine reaches state='running' for that model, or until timeoutMs elapses.
 *
 * `_fetch` is injectable for tests.
 */
async function loadAndWait(
  base: string,
  modelKey: string,
  timeoutMs = 180_000,
  _fetch: typeof fetch = fetch,
): Promise<boolean> {
  // POST the load request (fire-and-forget on the daemon side — returns 202).
  const loadRes = await _fetch(`${base}/api/v1/engine/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelKey }),
    signal: AbortSignal.timeout(5000),
  })
  if (!loadRes.ok) return false

  // Poll status until running with the expected model key.
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 1000))
    try {
      const res = await _fetch(`${base}/api/v1/status`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) continue
      const st = (await res.json()) as DaemonStatus
      if (st.engine?.state === 'running' && st.model?.key === modelKey) return true
      // If the engine errored out, stop polling early.
      if (st.engine?.state === 'error') return false
    } catch {
      /* network hiccup — keep polling */
    }
  }
  return false
}

/** Launch `target` CLI wired to the TurboLLM gateway on 127.0.0.1:<port>. Returns
 *  the child's exit code (or a non-zero code on a setup failure). Pure launcher —
 *  it never starts the daemon itself.
 *
 *  `modelKey` — when provided, resolve + load that model before launching.
 *  `_spawn` is an optional injection point used by unit tests to capture the env
 *  passed to the child process without actually launching Claude Code.
 *  `_fetch` is an optional injection point used by unit tests to stub HTTP calls. */
export async function launchCli(
  target: string,
  port: number,
  passthrough: string[],
  _spawn: SpawnLike = spawn,
  modelKey?: string,
  _fetch: typeof fetch = fetch,
): Promise<number> {
  const spec = SUPPORTED[target]
  if (!target || !spec) {
    const list = Object.keys(SUPPORTED).join(', ')
    process.stderr.write(`Usage: turbollm launch <cli>   (supported: ${list})\n`)
    return 1
  }

  const base = `http://127.0.0.1:${port}`

  // Confirm the daemon is up before anything else.
  let status: DaemonStatus | null
  try {
    const res = await _fetch(`${base}/api/v1/status`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    status = (await res.json()) as DaemonStatus
  } catch {
    process.stderr.write(
      `Could not reach TurboLLM at ${base}.\n` +
        `Start the daemon first — run \`turbollm\` in another terminal — or pass --port if it runs elsewhere.\n`,
    )
    return 1
  }

  const alreadyRunning =
    status?.engine?.state === 'running' && !!status?.model?.name

  if (modelKey) {
    // --model given: resolve against the library, then load if not already loaded.
    const models = await fetchModels(base, _fetch)
    const resolvedKey = resolveModelKey(models, modelKey)
    if (!resolvedKey) {
      const list = models.map((m) => `  ${m.key}  (${m.name})`).join('\n')
      process.stderr.write(
        `Model not found: "${modelKey}"\n` +
          (list ? `Available models:\n${list}\n` : `No models in library — add one via the TurboLLM UI.\n`),
      )
      return 1
    }
    // Already loaded with the same key — skip the load.
    if (alreadyRunning && status?.model?.key === resolvedKey) {
      // Fall through to launch.
    } else {
      process.stdout.write(`▸ Loading model "${resolvedKey}"…\n`)
      const loaded = await loadAndWait(base, resolvedKey, 180_000, _fetch)
      if (!loaded) {
        process.stderr.write(
          `Model did not finish loading within 180 s. ` +
            `Check the TurboLLM UI for errors, or try again.\n`,
        )
        return 1
      }
      // Re-fetch status to get the model name for the launch banner.
      const refreshed = await fetchStatus(base, _fetch)
      if (refreshed) status = refreshed
    }
  } else if (!alreadyRunning) {
    // No --model and no model loaded: auto-load the last-used / first available model.
    const models = await fetchModels(base, _fetch)
    if (models.length === 0) {
      process.stderr.write(
        `TurboLLM is running, but no model is loaded and no models are in the library.\n` +
          `Open ${base} → Models → add a model, then run this again.\n`,
      )
      return 1
    }
    // Prefer the true last-used model (exposed on /status as lastLoaded) when it's still
    // in the library; otherwise fall back to the first model in the list, which matches
    // the order the UI presents models.
    const lastKey = status?.lastLoaded?.modelKey
    const autoKey = lastKey && models.some((m) => m.key === lastKey) ? lastKey : models[0].key
    process.stdout.write(`▸ Auto-loading model "${autoKey}"…\n`)
    const loaded = await loadAndWait(base, autoKey, 180_000, _fetch)
    if (!loaded) {
      process.stderr.write(
        `Model did not finish loading within 180 s. ` +
          `Check the TurboLLM UI for errors, then run this again.\n`,
      )
      return 1
    }
    const refreshed = await fetchStatus(base, _fetch)
    if (refreshed) status = refreshed
  }

  // At this point we expect a model to be loaded.
  if (status?.engine?.state !== 'running' || !status?.model?.name) {
    process.stderr.write(
      `TurboLLM is running, but no model is loaded.\n` +
        `Open ${base} → Models → Load a model, then run this again.\n`,
    )
    return 1
  }
  const model = status.model.name

  // Only PIN a model id (via ANTHROPIC_MODEL) when the user explicitly asked for one with
  // --model. Without --model we leave it unset so Claude Code talks to whatever model the
  // gateway currently has loaded, as-is. Pinning makes Claude Code send that id on every
  // request, which forces the gateway's auto-swap router to resolve it and can surface
  // model-specific behaviour (e.g. a strict chat template) the user didn't ask for —
  // when they ran a bare `launch`, they just want "use the loaded model".
  const modelNote = modelKey ? `model: ${model}` : `using loaded model: ${model}`
  process.stdout.write(`▸ Launching ${spec.label} → TurboLLM  (${modelNote}, ${base})\n`)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: base,
    // No auth is enforced on the local gateway; the CLI just needs a non-empty token.
    ANTHROPIC_AUTH_TOKEN: 'turbollm-local',
    // Local LLMs are 30–120 s per response — raise Claude Code's request timeout so it
    // doesn't abort mid-generation. 300 s (5 min) covers even the slowest local model.
    // Zero retries: retrying a slow local model cold-starts it again and makes things worse.
    ANTHROPIC_TIMEOUT: '300000',
    ANTHROPIC_MAX_RETRIES: '0',
  }
  if (modelKey) {
    // --model was given: pin Claude Code to the resolved model.
    env.ANTHROPIC_MODEL = model
  } else {
    // No --model: do not set a model, and strip any ANTHROPIC_MODEL inherited from the
    // parent environment so a stray global value can't silently pin the model either.
    delete env.ANTHROPIC_MODEL
  }

  const child = _spawn(spec.bin, passthrough, {
    stdio: 'inherit',
    // On Windows the CLI is usually a `.cmd`/`.ps1` shim; a shell resolves it via PATHEXT.
    shell: process.platform === 'win32',
    env,
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
