import { test } from 'node:test'
import assert from 'node:assert/strict'
import { engineAcceptsFormat, engineModelAlias, ENGINE_MODEL_ALIAS } from './compat'
import { vllmServerCommand } from './vllm'

test('engineAcceptsFormat: gguf for llama.cpp forks, mlx for python engines', () => {
  assert.equal(engineAcceptsFormat('llama-server', 'gguf'), true)
  assert.equal(engineAcceptsFormat('llama-server', 'mlx'), false)
  assert.equal(engineAcceptsFormat('mlx', 'mlx'), true)
  assert.equal(engineAcceptsFormat('mlx', 'gguf'), false)
  assert.equal(engineAcceptsFormat('vllm', 'mlx'), true)
  assert.equal(engineAcceptsFormat('vllm', 'gguf'), false)
})

test('engineModelAlias: fixed alias for mlx/vllm, null (keep caller value) for llama.cpp', () => {
  // mlx-lm / vLLM serve under a fixed name and 404 on TurboLLM's internal key.
  assert.equal(engineModelAlias('mlx'), ENGINE_MODEL_ALIAS)
  assert.equal(engineModelAlias('vllm'), ENGINE_MODEL_ALIAS)
  // llama.cpp ignores the request model field — keep whatever the caller sent.
  assert.equal(engineModelAlias('llama-server'), null)
  assert.equal(engineModelAlias(''), null)
})

test('vllmServerCommand serves under the shared default_model alias', () => {
  const { args } = vllmServerCommand('py', '/models/some dir', 8000, '127.0.0.1')
  const i = args.indexOf('--served-model-name')
  assert.notEqual(i, -1)
  assert.equal(args[i + 1], ENGINE_MODEL_ALIAS)
})
