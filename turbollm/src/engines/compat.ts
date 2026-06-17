// Engine ↔ model compatibility (ADR-044). The single source of truth for which
// model formats an engine kind can load. Used by the load guard (routes), the
// model-list overlay (filter by active engine), and the CLI auto-load. The web UI
// mirrors this rule in web/src/lib/engineCompat.ts — keep the two in sync.

export type ModelFormat = 'gguf' | 'mlx'

/**
 * True when an engine of `engineKind` can load a model of `format`:
 *   - llama.cpp and its forks (e.g. TurboQuant, kind 'llama-server') → GGUF
 *   - MLX (kind 'mlx') → MLX-format safetensors directories
 *   - vLLM (kind 'vllm') → HF safetensors directories — the same on-disk shape the
 *     scanner tags 'mlx' (config.json + *.safetensors + tokenizer)
 */
export function engineAcceptsFormat(engineKind: string, format: ModelFormat): boolean {
  if (engineKind === 'mlx') return format === 'mlx'
  if (engineKind === 'vllm') return format === 'mlx'
  return format === 'gguf'
}

/**
 * The value an OpenAI-compatible request must put in its `model` field for this engine.
 *
 * llama.cpp ignores the field (it serves the single loaded model), so we leave the
 * caller's value alone. mlx-lm and vLLM, however, treat `model` as the model to serve
 * and 404 (vLLM) or fail to load (mlx-lm) if it doesn't match a known name — they would
 * never match TurboLLM's internal model key (a display name with spaces). We launch both
 * under the fixed alias `default_model` (mlx-lm's built-in alias for its `--model`; vLLM
 * via `--served-model-name`), so requests must send exactly that. Returns null when the
 * engine ignores the field and the original value should be kept.
 */
export const ENGINE_MODEL_ALIAS = 'default_model'
export function engineModelAlias(engineKind: string): string | null {
  return engineKind === 'mlx' || engineKind === 'vllm' ? ENGINE_MODEL_ALIAS : null
}
