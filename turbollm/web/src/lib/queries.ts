// TanStack Query hooks: status poll + engines list, plus engine mutations that
// invalidate the relevant queries on success (spec 00 §4).

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import {
  activateEngine,
  addEngine,
  addModelDir,
  browseFs,
  cancelDownload,
  enqueueDownload,
  getApiKeys,
  getConnect,
  getEngineBackends,
  getModelDetail,
  getModelDirs,
  getModels,
  getNetworkInfo,
  getSysInfo,
  getTelemetryPreview,
  cancelBackendDownload,
  cancelBench,
  createApiKey,
  deleteApiKey,
  deleteEngineBackend,
  getStatus,
  startBench,
  getSettings,
  hfRepo,
  hfSearch,
  hfTokenTest,
  installBackend,
  installMlx,
  listDownloads,
  listEngines,
  loadModel,
  removeDownload,
  removeEngine,
  removeModelDir,
  renameEngine,
  setPrimaryModelDir,
  reprobeEngine,
  rescanModels,
  resetModelProfile,
  restartDaemon,
  restartEngine,
  saveModelProfile,
  saveSettings,
  startEngine,
  stopEngine,
  type DaemonSettingsPatch,
  type SysInfo,
  type TelemetryLevel,
} from './api'
import type {
  BenchState,
  DownloadsList,
  EngineBackends,
  EngineStats,
  EnginesList,
  HfRepoDetail,
  HfSearchResult,
  LoadProfile,
  ModelDetail,
  ModelDirs,
  ModelsList,
  Status,
} from './types'
// SysInfo is defined in api.ts (not types.ts) — re-export for convenience
export type { SysInfo }

export const queryKeys = {
  status: ['status'] as const,
  engines: ['engines'] as const,
  engineBackends: ['engine-backends'] as const,
  models: ['models'] as const,
  modelDirs: ['modeldirs'] as const,
  downloads: ['downloads'] as const,
}

/** Status poll every 2s, paused when the tab is hidden (spec 00 §4). Polls at 1s
 *  while an auto-tune sweep runs so the inline progress stays live (spec 09 §1). */
export function useStatus(): UseQueryResult<Status> {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: getStatus,
    refetchInterval: (q) => (q.state.data?.bench.running ? 1000 : 2000),
    refetchIntervalInBackground: false,
    // Keep the prior value visible while a poll is in flight to avoid flicker.
    placeholderData: (prev) => prev,
    retry: false,
  })
}

/** Auto-tune state (spec 09 §1), selected off the status poll (no extra request).
 *  Carries live progress while running and the lingering done/error result after. */
export function useBenchState(): BenchState | null {
  const { data } = useStatus()
  return data?.bench ?? null
}

/** Start / cancel an auto-tune sweep (spec 09 §1). Invalidates models + status so the
 *  saved profile + benchTps refresh once the run lands. */
export function useBenchActions() {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.status })
    void qc.invalidateQueries({ queryKey: queryKeys.models })
  }
  return {
    start: useMutation({
      mutationFn: (modelKey: string) => startBench(modelKey),
      onSuccess: (_d, modelKey) => {
        invalidate()
        void qc.invalidateQueries({ queryKey: ['model', modelKey] })
      },
    }),
    cancel: useMutation({ mutationFn: () => cancelBench(), onSuccess: invalidate }),
  }
}

/** Live running-session stats (B4), selected off the status poll (no extra
 *  request). Null unless the engine is running. */
export function useEngineStats(): EngineStats | null {
  const { data } = useStatus()
  return data?.engine.state === 'running' ? data.engineStats ?? null : null
}

export function useEngines(): UseQueryResult<EnginesList> {
  return useQuery({
    queryKey: queryKeys.engines,
    queryFn: listEngines,
    retry: false,
  })
}

/** Available llama.cpp backends + the hardware-recommended one (ADR-025).
 *  Polls while a provision is active so installed/active flags stay fresh. */
export function useEngineBackends(provisioning: boolean): UseQueryResult<EngineBackends> {
  return useQuery({
    queryKey: queryKeys.engineBackends,
    queryFn: getEngineBackends,
    refetchInterval: provisioning ? 2000 : false,
    retry: false,
  })
}

export function useBackendInstall() {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.engineBackends })
    void qc.invalidateQueries({ queryKey: queryKeys.engines })
    void qc.invalidateQueries({ queryKey: queryKeys.status })
  }
  return {
    backend: useMutation({ mutationFn: (backend: string) => installBackend(backend), onSuccess: invalidate }),
    mlx: useMutation({ mutationFn: () => installMlx(), onSuccess: invalidate }),
    cancel: useMutation({ mutationFn: () => cancelBackendDownload(), onSuccess: invalidate }),
    remove: useMutation({ mutationFn: (id: string) => deleteEngineBackend(id), onSuccess: invalidate }),
  }
}

export function useEngineMutations() {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.engines })
    void qc.invalidateQueries({ queryKey: queryKeys.status })
    // Activating/removing an engine changes the official backends' active/installed
    // projection too — keep the Engine→Build selector in sync.
    void qc.invalidateQueries({ queryKey: queryKeys.engineBackends })
  }

  return {
    add: useMutation({
      mutationFn: addEngine,
      onSuccess: invalidate,
    }),
    rename: useMutation({
      mutationFn: (v: { id: string; name: string }) => renameEngine(v.id, v.name),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => removeEngine(id),
      onSuccess: invalidate,
    }),
    activate: useMutation({
      mutationFn: (id: string) => activateEngine(id),
      onSuccess: invalidate,
    }),
    reprobe: useMutation({
      mutationFn: (id: string) => reprobeEngine(id),
      onSuccess: invalidate,
    }),
    start: useMutation({ mutationFn: startEngine, onSuccess: invalidate }),
    stop: useMutation({ mutationFn: stopEngine, onSuccess: invalidate }),
    restart: useMutation({ mutationFn: restartEngine, onSuccess: invalidate }),
  }
}

/** Browse a directory for the engine-binary picker (spec 03 §9). `path` is the
 *  directory to list; null defers to the daemon's home dir. Disabled until the
 *  browser is opened so it doesn't fetch on mount. */
export function useFsBrowse(path: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['fs-browse', path],
    queryFn: () => browseFs(path ?? undefined),
    enabled,
    retry: false,
    placeholderData: (prev) => prev,
  })
}

/** Model list; polls faster while a scan is in flight, gently while a model is
 *  loaded so the live t/s chip stays fresh (spec 04 §5), and at 1s while the
 *  engine is starting so the loaded flag updates as soon as the model is ready. */
export function useModels(): UseQueryResult<ModelsList> {
  const qc = useQueryClient()
  return useQuery({
    queryKey: queryKeys.models,
    queryFn: getModels,
    refetchInterval: (q) => {
      if (q.state.data?.scanning) return 1200
      if (q.state.data?.models.some((m) => m.loaded)) return 4000
      const status = qc.getQueryData<Status>(queryKeys.status)
      if (status?.engine.state === 'starting') return 1000
      return false
    },
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
    retry: false,
  })
}

export function useModelDirs(): UseQueryResult<ModelDirs> {
  return useQuery({ queryKey: queryKeys.modelDirs, queryFn: getModelDirs, retry: false })
}

export function useModelMutations() {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.models })
    void qc.invalidateQueries({ queryKey: queryKeys.modelDirs })
  }
  return {
    rescan: useMutation({ mutationFn: rescanModels, onSuccess: invalidate }),
    addDir: useMutation({ mutationFn: (dir: string) => addModelDir(dir), onSuccess: invalidate }),
    removeDir: useMutation({ mutationFn: (dir: string) => removeModelDir(dir), onSuccess: invalidate }),
    setPrimaryDir: useMutation({ mutationFn: (dir: string) => setPrimaryModelDir(dir), onSuccess: invalidate }),
  }
}

/** LAN network info (spec 08 §2). Disabled by default; the Settings Network section
 *  enables it when shown. Polled lightly so the hasApiKey hint stays fresh. */
export function useNetworkInfo(enabled = true) {
  return useQuery({
    queryKey: ['network'],
    queryFn: getNetworkInfo,
    enabled,
    retry: false,
  })
}

/** Telemetry preview for a level (spec 09 §4): a representative example of what
 *  would be sent. Nothing is transmitted. Disabled until a level is requested. */
export function useTelemetryPreview(level: TelemetryLevel | null) {
  return useQuery({
    queryKey: ['telemetry-preview', level],
    queryFn: () => getTelemetryPreview(level as TelemetryLevel),
    enabled: !!level,
    retry: false,
    staleTime: Infinity,
  })
}

export function useSettings() {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
    retry: false,
  })
  const save = useMutation({
    mutationFn: (patch: DaemonSettingsPatch) => saveSettings(patch),
    onSuccess: (data) => {
      qc.setQueryData(['settings'], data)
    },
  })
  return { query, save }
}

/** Restart the whole daemon (spec 08 §2). The socket drops mid-restart, so the
 *  caller drives a "Restarting…" overlay + /status poll itself. */
export function useDaemonRestart() {
  return useMutation({ mutationFn: () => restartDaemon() })
}

/** Model detail (entry + resolved profile + VRAM fit). Disabled when key is null. */
export function useModelDetail(key: string | null): UseQueryResult<ModelDetail> {
  return useQuery({
    queryKey: ['model', key],
    queryFn: () => getModelDetail(key as string),
    enabled: !!key,
    retry: false,
  })
}

export function useModelActions() {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.models })
    void qc.invalidateQueries({ queryKey: queryKeys.status })
  }
  return {
    save: useMutation({
      mutationFn: (v: { key: string; profile: LoadProfile }) => saveModelProfile(v.key, v.profile),
      onSuccess: (_d, v) => {
        invalidate()
        void qc.invalidateQueries({ queryKey: ['model', v.key] })
      },
    }),
    reset: useMutation({
      mutationFn: (key: string) => resetModelProfile(key),
      onSuccess: (_d, key) => {
        invalidate()
        void qc.invalidateQueries({ queryKey: ['model', key] })
      },
    }),
    load: useMutation({
      mutationFn: (v: { key: string; overrides?: Partial<LoadProfile> }) => loadModel(v.key, v.overrides),
      onSuccess: (_d, v) => {
        invalidate()
        void qc.invalidateQueries({ queryKey: ['model', v.key] })
      },
    }),
    eject: useMutation({
      mutationFn: () => stopEngine(),
      onSuccess: invalidate,
    }),
  }
}

// ── API keys (spec 06 §5) ─────────────────────────────────────────────────────
export function useApiKeys() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['apiKeys'], queryFn: getApiKeys, retry: false })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['apiKeys'] })
  return {
    query,
    create: useMutation({ mutationFn: (name: string) => createApiKey(name), onSuccess: invalidate }),
    revoke: useMutation({ mutationFn: (id: string) => deleteApiKey(id), onSuccess: invalidate }),
  }
}

// ── CLI connect snippets (spec 06 §6) ─────────────────────────────────────────
export function useConnect(cli: string) {
  return useQuery({
    queryKey: ['connect', cli],
    queryFn: () => getConnect(cli),
    enabled: false,
    retry: false,
    staleTime: Infinity,
  })
}

// ── Hugging Face discovery (spec 10 §2–4) ────────────────────────────────────
/** Search GGUF repos. Disabled until a non-empty query is set (the Discover tab
 *  debounces the input before passing it here). */
export function useHfSearch(q: string): UseQueryResult<HfSearchResult> {
  return useQuery({
    queryKey: ['hf-search', q],
    queryFn: () => hfSearch(q),
    enabled: q.trim().length > 0,
    retry: false,
    placeholderData: (prev) => prev,
  })
}

/** Repo detail (files + sizes + gated). Disabled until a repo is selected. */
export function useHfRepo(repo: string | null): UseQueryResult<HfRepoDetail> {
  return useQuery({
    queryKey: ['hf-repo', repo],
    queryFn: () => hfRepo(repo as string),
    enabled: !!repo,
    retry: false,
  })
}

/** Test an HF token (spec 10 §4). Mutation so the Settings "Test" button can show
 *  the username on success / error envelope on failure. */
export function useHfTokenTest() {
  return useMutation({ mutationFn: (token: string) => hfTokenTest(token) })
}

// ── Downloads (spec 10 §5–6, §8) ──────────────────────────────────────────────
/** Downloads list, polled every 1.5s while any job is active so progress/speed
 *  stay live; otherwise refetched on focus only. */
export function useDownloads(): UseQueryResult<DownloadsList> {
  return useQuery({
    queryKey: queryKeys.downloads,
    queryFn: listDownloads,
    refetchInterval: (q) =>
      q.state.data?.downloads.some((dl) => dl.status === 'downloading' || dl.status === 'queued') ? 1500 : false,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
    retry: false,
  })
}

export function useDownloadMutations() {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.downloads })
    // A completed download adds a model to the library.
    void qc.invalidateQueries({ queryKey: queryKeys.models })
    void qc.invalidateQueries({ queryKey: queryKeys.status })
  }
  return {
    enqueue: useMutation({
      mutationFn: (input: { repo?: string; rfilename?: string; url?: string; size?: number; sha256?: string }) =>
        enqueueDownload(input),
      onSuccess: invalidate,
    }),
    cancel: useMutation({ mutationFn: (id: string) => cancelDownload(id), onSuccess: invalidate }),
    remove: useMutation({ mutationFn: (id: string) => removeDownload(id), onSuccess: invalidate }),
  }
}

// ── System info (spec 05 §6) — loaded once on mount, never re-polled ─────────
export function useSysInfo(): UseQueryResult<SysInfo> {
  return useQuery({
    queryKey: ['sysinfo'],
    queryFn: getSysInfo,
    staleTime: Infinity,
    retry: false,
  })
}
