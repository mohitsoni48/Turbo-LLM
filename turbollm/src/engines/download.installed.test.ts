import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installedBackendBuild, deleteAllBackendBuilds } from './download'

const serverBin = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'tllm-dl-'))
}

/** Create an extracted backend build dir `llama.cpp-<tag>-<id>/` with a server binary. */
function seedBuild(root: string, tag: string, id: string): string {
  const dir = join(root, `llama.cpp-${tag}-${id}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, serverBin), '')
  return dir
}

test('installedBackendBuild is tag-agnostic — finds a build de-pinned off LLAMA_BUILD', () => {
  const root = tmpRoot()
  // Only a b9754 build exists (no pinned b9608) — the old pinned check would miss it.
  seedBuild(root, 'b9754', 'cuda')
  const found = installedBackendBuild(root, 'cuda')
  assert.ok(found, 'should find the de-pinned build')
  assert.equal(found!.tag, 'b9754')
  assert.ok(found!.bin.endsWith(serverBin))
})

test('installedBackendBuild picks the NEWEST build when several are present', () => {
  const root = tmpRoot()
  seedBuild(root, 'b9744', 'cuda')
  seedBuild(root, 'b9754', 'cuda')
  seedBuild(root, 'b9700', 'cuda')
  assert.equal(installedBackendBuild(root, 'cuda')!.tag, 'b9754')
})

test('installedBackendBuild does not cross backends', () => {
  const root = tmpRoot()
  seedBuild(root, 'b9754', 'cuda')
  assert.equal(installedBackendBuild(root, 'rocm'), null)
  assert.equal(installedBackendBuild(root, 'cuda')!.tag, 'b9754')
})

test('installedBackendBuild ignores a build dir with no server binary', () => {
  const root = tmpRoot()
  mkdirSync(join(root, 'llama.cpp-b9754-cuda'), { recursive: true }) // empty, no binary
  assert.equal(installedBackendBuild(root, 'cuda'), null)
})

test('installedBackendBuild returns null for a missing engines root', () => {
  assert.equal(installedBackendBuild(join(tmpdir(), 'tllm-does-not-exist-xyz'), 'cuda'), null)
})

test('deleteAllBackendBuilds removes every build of a backend, leaving others intact', () => {
  const root = tmpRoot()
  seedBuild(root, 'b9744', 'cuda')
  seedBuild(root, 'b9754', 'cuda')
  seedBuild(root, 'b9754', 'rocm')
  const removed = deleteAllBackendBuilds(root, 'cuda')
  assert.equal(removed, 2)
  assert.ok(!existsSync(join(root, 'llama.cpp-b9744-cuda')))
  assert.ok(!existsSync(join(root, 'llama.cpp-b9754-cuda')))
  assert.ok(existsSync(join(root, 'llama.cpp-b9754-rocm')), 'rocm build is untouched')
  assert.deepEqual(readdirSync(root), ['llama.cpp-b9754-rocm'])
})
