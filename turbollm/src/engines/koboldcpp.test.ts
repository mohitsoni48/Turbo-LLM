// Phase 4: KoboldCpp engine. Pure unit tests for the launch command, the profile →
// KoboldCpp arg-map, and the release-asset selection (asset names verified against the
// LostRuins/koboldcpp v1.115.x release: koboldcpp.exe / koboldcpp-nocuda.exe /
// koboldcpp-linux-x64[-nocuda] / koboldcpp-mac-arm64).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  koboldcppAssetName,
  koboldcppProfileToArgs,
  koboldcppServerCommand,
  pickKoboldcppAsset,
} from './koboldcpp'
import type { ReleaseAsset } from './download'

test('koboldcppServerCommand passes model/host/port + skiplauncher and appends extraArgs', () => {
  const { cmd, args } = koboldcppServerCommand('/bin/koboldcpp', '/models/x.gguf', 8081, '127.0.0.1', [
    '--contextsize',
    '8192',
    '--usecuda',
  ])
  assert.equal(cmd, '/bin/koboldcpp')
  assert.deepEqual(args, [
    '--model',
    '/models/x.gguf',
    '--host',
    '127.0.0.1',
    '--port',
    '8081',
    '--skiplauncher',
    '--contextsize',
    '8192',
    '--usecuda',
  ])
})

test('koboldcppProfileToArgs: NVIDIA GPU → contextsize + gpulayers + usecuda', () => {
  const args = koboldcppProfileToArgs({ ctx: 8192, ngl: 99 }, 'nvidia', true)
  assert.deepEqual(args, ['--contextsize', '8192', '--gpulayers', '99', '--usecuda'])
})

test('koboldcppProfileToArgs: non-NVIDIA GPU → usevulkan', () => {
  const args = koboldcppProfileToArgs({ ctx: 4096, ngl: 40 }, 'amd', true)
  assert.deepEqual(args, ['--contextsize', '4096', '--gpulayers', '40', '--usevulkan'])
})

test('koboldcppProfileToArgs: no GPU → nogpu, no gpulayers flag', () => {
  const args = koboldcppProfileToArgs({ ctx: 2048, ngl: 0 }, 'unknown', false)
  assert.deepEqual(args, ['--contextsize', '2048', '--nogpu'])
})

test('koboldcppProfileToArgs: ngl 0 on a GPU box still means CPU (nogpu, no gpulayers)', () => {
  const args = koboldcppProfileToArgs({ ctx: 2048, ngl: 0 }, 'nvidia', true)
  assert.deepEqual(args, ['--contextsize', '2048', '--nogpu'])
})

test('koboldcppProfileToArgs: user extraArgs pass through last', () => {
  const args = koboldcppProfileToArgs({ ctx: 4096, ngl: 10, extraArgs: ['--flashattention'] }, 'nvidia', true)
  assert.deepEqual(args.slice(-1), ['--flashattention'])
})

test('koboldcppAssetName: Windows x64 picks CUDA vs nocuda build by GPU', () => {
  assert.equal(koboldcppAssetName(true, 'win32', 'x64'), 'koboldcpp.exe')
  assert.equal(koboldcppAssetName(false, 'win32', 'x64'), 'koboldcpp-nocuda.exe')
  // No Windows-arm64 KoboldCpp asset.
  assert.equal(koboldcppAssetName(true, 'win32', 'arm64'), null)
})

test('koboldcppAssetName: Linux x64 picks CUDA vs nocuda build by GPU', () => {
  assert.equal(koboldcppAssetName(true, 'linux', 'x64'), 'koboldcpp-linux-x64')
  assert.equal(koboldcppAssetName(false, 'linux', 'x64'), 'koboldcpp-linux-x64-nocuda')
  assert.equal(koboldcppAssetName(true, 'linux', 'arm64'), null)
})

test('koboldcppAssetName: macOS only Apple Silicon', () => {
  assert.equal(koboldcppAssetName(false, 'darwin', 'arm64'), 'koboldcpp-mac-arm64')
  assert.equal(koboldcppAssetName(true, 'darwin', 'x64'), null)
})

test('pickKoboldcppAsset matches the wanted asset by exact name', () => {
  const assets: ReleaseAsset[] = [
    { name: 'koboldcpp.exe', browser_download_url: 'u1' },
    { name: 'koboldcpp-nocuda.exe', browser_download_url: 'u2' },
    { name: 'koboldcpp-linux-x64', browser_download_url: 'u3' },
    { name: 'koboldcpp-mac-arm64', browser_download_url: 'u4' },
  ]
  assert.equal(pickKoboldcppAsset(assets, true, 'win32', 'x64')?.name, 'koboldcpp.exe')
  assert.equal(pickKoboldcppAsset(assets, false, 'win32', 'x64')?.name, 'koboldcpp-nocuda.exe')
  assert.equal(pickKoboldcppAsset(assets, true, 'linux', 'x64')?.name, 'koboldcpp-linux-x64')
  assert.equal(pickKoboldcppAsset(assets, false, 'darwin', 'arm64')?.name, 'koboldcpp-mac-arm64')
  // Unsupported OS/arch → null even when assets exist.
  assert.equal(pickKoboldcppAsset(assets, true, 'win32', 'arm64'), null)
})

test('pickKoboldcppAsset returns null when the wanted asset is missing', () => {
  const assets: ReleaseAsset[] = [{ name: 'koboldcpp-mac-arm64', browser_download_url: 'u' }]
  assert.equal(pickKoboldcppAsset(assets, true, 'win32', 'x64'), null)
})
