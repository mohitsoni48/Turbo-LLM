import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { hfHubCacheDir } from './hf-cache'

const HOME = join('/tmp', 'fakehome')

test('HUGGINGFACE_HUB_CACHE is used directly when set', () => {
  const dir = hfHubCacheDir({ HUGGINGFACE_HUB_CACHE: '/explicit/hub', HF_HOME: '/hf' }, HOME)
  assert.equal(dir, '/explicit/hub')
})

test('HF_HOME resolves to join(HF_HOME, "hub") when hub-cache is unset', () => {
  const dir = hfHubCacheDir({ HF_HOME: join('/data', 'hf') }, HOME)
  assert.equal(dir, join('/data', 'hf', 'hub'))
})

test('falls back to ~/.cache/huggingface/hub with no env', () => {
  const dir = hfHubCacheDir({}, HOME)
  assert.equal(dir, join(HOME, '.cache', 'huggingface', 'hub'))
})

test('blank env values are ignored (treated as unset)', () => {
  const dir = hfHubCacheDir({ HUGGINGFACE_HUB_CACHE: '   ', HF_HOME: '' }, HOME)
  assert.equal(dir, join(HOME, '.cache', 'huggingface', 'hub'))
})

test('blank HUGGINGFACE_HUB_CACHE falls through to HF_HOME', () => {
  const dir = hfHubCacheDir({ HUGGINGFACE_HUB_CACHE: '  ', HF_HOME: '/hf' }, HOME)
  assert.equal(dir, join('/hf', 'hub'))
})
