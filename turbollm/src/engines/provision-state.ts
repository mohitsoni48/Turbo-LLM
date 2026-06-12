// Live status of default-engine provisioning (ADR-024), surfaced via GET
// /api/v1/status so the web UI can show a download/extract progress bar.
// Single in-process holder; provisioning runs once at startup.

export interface ProvisionStatus {
  active: boolean
  phase: 'idle' | 'downloading' | 'extracting' | 'error'
  backend: string
  pct: number // 0..1 while downloading; -1 = indeterminate (extracting)
  part: number // 1-based current archive (multi-asset backends like CUDA)
  parts: number // total archives for this backend
  error: string | null
}

export class ProvisionState {
  private s: ProvisionStatus = { active: false, phase: 'idle', backend: '', pct: 0, part: 1, parts: 1, error: null }

  get(): ProvisionStatus {
    return { ...this.s }
  }

  start(backend: string): void {
    this.s = { active: true, phase: 'downloading', backend, pct: 0, part: 1, parts: 1, error: null }
  }

  progress(phase: 'downloading' | 'extracting', pct: number, part = 1, parts = 1): void {
    if (!this.s.active) return
    this.s.phase = phase
    this.s.pct = pct
    this.s.part = part
    this.s.parts = parts
  }

  done(): void {
    this.s = { active: false, phase: 'idle', backend: '', pct: 0, part: 1, parts: 1, error: null }
  }

  fail(error: string): void {
    this.s = { active: false, phase: 'error', backend: this.s.backend, pct: 0, part: 1, parts: 1, error }
  }
}
