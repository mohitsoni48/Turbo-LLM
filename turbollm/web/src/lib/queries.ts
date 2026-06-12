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
  getEngineBackends,
  getModelDetail,
  getModelDirs,
  getModels,
  getStatus,
  installBackend,
  installMlx,
  listEngines,
  loadModel,
  removeEngine,
  removeModelDir,
  renameEngine,
  reprobeEngine,
  rescanModels,
  resetModelProfile,
  restartEngine,
  saveModelProfile,
  startEngine,
  stopEngine,
} from './api'
import type { EngineBackends, EnginesList, LoadProfile, ModelDetail, ModelDirs, ModelsList, Status } from './types'

export const queryKeys = {
  status: ['status'] as const,
  engines: ['engines'] as const,
  engineBackends: ['engine-backends'] as const,
  models: ['models'] as const,
  modelDirs: ['modeldirs'] as const,
}

/** Status poll every 2s, paused when the tab is hidden (spec 00 §4). */
export function useStatus(): UseQueryResult<Status> {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: getStatus,
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
    // Keep the prior value visible while a poll is in flight to avoid flicker.
    placeholderData: (prev) => prev,
    retry: false,
  })
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
  }
}

export function useEngineMutations() {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.engines })
    void qc.invalidateQueries({ queryKey: queryKeys.status })
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

/** Model list; polls faster while a scan is in flight (spec 04). */
export function useModels(): UseQueryResult<ModelsList> {
  return useQuery({
    queryKey: queryKeys.models,
    queryFn: getModels,
    refetchInterval: (q) => (q.state.data?.scanning ? 1200 : false),
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
  }
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
