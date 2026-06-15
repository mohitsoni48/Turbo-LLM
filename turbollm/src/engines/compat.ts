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
