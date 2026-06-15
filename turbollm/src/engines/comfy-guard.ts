// ComfyUI GPU coordinator — PUSH model (no polling). A one-time-installed ComfyUI
// custom node (see ../comfyui/gate-template.ts) calls TurboLLM the instant a render
// starts and when its queue drains, so the handoff is event-driven and deterministic:
//
//   POST /api/v1/comfyui/acquire → guard.acquire(): force-unload the model (freeing
//     VRAM before ComfyUI executes) and BLOCK new loads. Returns once VRAM is free.
//   POST /api/v1/comfyui/release → guard.release(): reload the exact model we unloaded.
//
// The guard owns no engine state of its own — it reads Manager.status()/currentOpts()
// and drives Manager.stopAndWait({force})/start(), the same primitives the HTTP load
// route uses. A lease backstop auto-releases if ComfyUI crashes mid-render and never
// sends release (a local timer, not a poll of ComfyUI).
import type { ConfigStore } from '../config/config'
import type { Manager, StartOpts } from './manager'

/** Backstop: if `release` never arrives (ComfyUI crashed mid-render), auto-release
 *  after this long so the model doesn't stay unloaded forever. Each acquire re-arms
 *  it. Must exceed the longest single render; override with TURBOLLM_COMFY_LEASE_MIN. */
const LEASE_MINUTES = (() => {
  const v = Number(process.env.TURBOLLM_COMFY_LEASE_MIN)
  return Number.isFinite(v) && v > 0 ? v : 30
})()

/** What the guard exposes to /status so the UI can explain a paused/unloaded engine. */
export interface ComfyStatus {
  enabled: boolean
  /** The gate node has been installed (a path is recorded in config). */
  installed: boolean
  /** Holding the GPU for ComfyUI right now (model unloaded, loads blocked). */
  held: boolean
  /** Model loads are currently blocked (enabled && held). */
  blocked: boolean
  /** Key of the model we unloaded for ComfyUI and will reload on release. */
  suspendedModelKey: string | null
  /** ms since the last acquire/heartbeat signal from ComfyUI, or null if none yet. */
  lastSignalAgoMs: number | null
}

export class ComfyGuard {
  private held = false
  // The model we unloaded because ComfyUI started — reloaded on release.
  private suspended: StartOpts | null = null
  private leaseTimer: ReturnType<typeof setTimeout> | null = null
  private lastSignalAt = 0
  // Serialize concurrent acquire() calls (rapid-fire enqueues) onto one unload.
  private acquiring: Promise<void> | null = null

  private readonly leaseMs: number

  constructor(
    private store: ConfigStore,
    private manager: Manager,
    /** Crash-recovery lease in minutes (defaults to env/30). Injectable for tests. */
    leaseMinutes: number = LEASE_MINUTES,
  ) {
    this.leaseMs = Math.max(1, leaseMinutes * 60_000)
  }

  private enabled(): boolean {
    return this.store.snapshot().comfyui.enabled
  }

  /** True when a model load should be refused right now (ComfyUI holds the GPU). The
   *  HTTP load route, bench route, and startup auto-load all consult this. */
  isBlocked(): boolean {
    return this.enabled() && this.held
  }

  /** ComfyUI is starting/continuing a render: free the GPU and block loads. Resolves
   *  once VRAM is actually free, so the caller (ComfyUI) can safely begin executing.
   *  Idempotent — repeated calls just refresh the crash-recovery lease. */
  async acquire(): Promise<void> {
    if (!this.enabled()) return
    this.lastSignalAt = Date.now()
    this.armLease()
    if (this.held) return
    if (this.acquiring) return this.acquiring
    this.acquiring = (async () => {
      const st = this.manager.status()
      if (st.state === 'running' || st.state === 'starting') {
        const opts = this.manager.currentOpts()
        if (opts && !this.suspended) this.suspended = opts
        console.log('[comfy-guard] ComfyUI acquired the GPU — force-unloading the model.')
        await this.manager.stopAndWait({ force: true })
      }
      this.held = true
    })()
    try {
      await this.acquiring
    } finally {
      this.acquiring = null
    }
  }

  /** ComfyUI's queue drained: unblock loads and reload the model we unloaded for it. */
  async release(): Promise<void> {
    this.clearLease()
    this.lastSignalAt = Date.now()
    if (!this.held && !this.suspended) return
    this.held = false
    const opts = this.suspended
    this.suspended = null
    if (opts) {
      console.log('[comfy-guard] ComfyUI released the GPU — reloading the previous model.')
      try {
        await this.manager.start(opts)
      } catch (e) {
        console.warn(`[comfy-guard] reload after ComfyUI failed: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  snapshot(): ComfyStatus {
    const cfg = this.store.snapshot().comfyui
    return {
      enabled: cfg.enabled,
      installed: !!cfg.gatePath,
      held: cfg.enabled && this.held,
      blocked: cfg.enabled && this.held,
      suspendedModelKey: this.suspended?.model.key ?? null,
      lastSignalAgoMs: this.lastSignalAt ? Date.now() - this.lastSignalAt : null,
    }
  }

  /** Stop the lease timer (daemon shutdown/restart) so a backstop can't fire mid-teardown. */
  stop(): void {
    this.clearLease()
  }

  private armLease(): void {
    this.clearLease()
    this.leaseTimer = setTimeout(() => {
      console.warn('[comfy-guard] no ComfyUI signal before lease expiry — auto-releasing (assuming ComfyUI exited).')
      void this.release()
    }, this.leaseMs)
    this.leaseTimer.unref?.()
  }

  private clearLease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer)
    this.leaseTimer = null
  }
}
