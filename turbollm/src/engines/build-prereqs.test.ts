import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCommands } from './build-prereqs'

test('buildCommands: includes --branch when a branch is given', () => {
  const cmds = buildCommands('https://github.com/owner/repo', 'main')
  assert.equal(cmds[0], 'git clone --branch "main" --depth 1 "https://github.com/owner/repo" turbo-build')
})

test('buildCommands: omits --branch when no branch (or empty/whitespace) is given', () => {
  const expected = 'git clone --depth 1 "https://github.com/owner/repo" turbo-build'
  assert.equal(buildCommands('https://github.com/owner/repo')[0], expected)
  assert.equal(buildCommands('https://github.com/owner/repo', '')[0], expected)
  assert.equal(buildCommands('https://github.com/owner/repo', '   ')[0], expected)
})

test('buildCommands: passes the repo URL through verbatim', () => {
  const url = 'https://github.com/ikawrakow/ik_llama.cpp.git'
  const cmds = buildCommands(url, 'sidestream')
  assert.ok(cmds[0].includes(url))
})

test('buildCommands: produces the Windows + CUDA cmake steps and the binary-location note', () => {
  const cmds = buildCommands('https://github.com/owner/repo')
  assert.deepEqual(cmds.slice(1, 4), [
    'cd turbo-build',
    'cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release',
    'cmake --build build --config Release -j --target llama-server',
  ])
  assert.match(cmds[cmds.length - 1], /llama-server\.exe/)
  assert.match(cmds[cmds.length - 1], /Add your own engine/)
})
