// HuggingFace hub cache location (ADR-092). On first run, when the user has no
// model directories configured, the daemon seeds this dir as the primary so any
// models already pulled by `huggingface-cli`/`transformers`/`hf_hub_download`
// show up immediately. Resolution mirrors the huggingface_hub library:
//   HUGGINGFACE_HUB_CACHE  → used directly (the explicit hub-cache override)
//   HF_HOME                → join(HF_HOME, 'hub')
//   else                   → ~/.cache/huggingface/hub
// Pure-ish: reads env + home only, never touches the filesystem. Injectable for
// tests.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConfigStore } from '../config/config'
import type { Scanner } from './scanner'

export interface HfCacheEnv {
  HUGGINGFACE_HUB_CACHE?: string
  HF_HOME?: string
}

/** Resolve the HuggingFace hub cache directory. Env + home are injectable so the
 *  resolution order is unit-testable without mutating process state. Never throws. */
export function hfHubCacheDir(env: HfCacheEnv = process.env, home: string = homedir()): string {
  const explicit = env.HUGGINGFACE_HUB_CACHE
  if (explicit && explicit.trim()) return explicit
  const hfHome = env.HF_HOME
  if (hfHome && hfHome.trim()) return join(hfHome, 'hub')
  return join(home, '.cache', 'huggingface', 'hub')
}

/** First-run seed (ADR-092): when no model directories are configured AND the HF hub
 *  cache exists on disk, adopt it as the primary so pre-existing HF models show up
 *  immediately. One-time only — never overrides a user who already has dirs. Triggers
 *  a background rescan. Never throws (a missing dir just skips). */
export function seedDefaultModelDir(store: ConfigStore, scanner: Scanner): void {
  try {
    if (store.snapshot().modelDirs.length > 0) return
    const dir = hfHubCacheDir()
    if (!existsSync(dir)) return
    store.update((c) => {
      c.modelDirs = [dir]
      c.primaryModelDir = dir
    })
    console.log(`seed: adopted HuggingFace hub cache as the default model folder (${dir})`)
    void scanner.rescan()
  } catch {
    /* best-effort — never block startup over the model-dir seed */
  }
}
