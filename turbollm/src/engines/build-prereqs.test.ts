import { test } from 'node:test'
import assert from 'node:assert/strict'
import { delimiter } from 'node:path'
import { buildCommands, buildEnv } from './build-prereqs'

const PATH_KEY = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'

test('buildEnv: no dirs → a copy of process.env (PATH unchanged)', () => {
  const env = buildEnv([])
  assert.equal(env[PATH_KEY], process.env[PATH_KEY])
  assert.notEqual(env, process.env) // a copy, not the live object
})

test('buildEnv: prepends dirs to PATH in order, before the inherited PATH', () => {
  const env = buildEnv(['C:\\conda\\env\\bin', 'C:\\cuda\\bin'])
  const parts = (env[PATH_KEY] ?? '').split(delimiter)
  assert.equal(parts[0], 'C:\\conda\\env\\bin')
  assert.equal(parts[1], 'C:\\cuda\\bin')
  assert.ok((env[PATH_KEY] ?? '').endsWith(process.env[PATH_KEY] ?? ''))
})

test('buildEnv: drops empty/whitespace dirs', () => {
  const env = buildEnv(['', '   ', 'C:\\real'])
  assert.equal((env[PATH_KEY] ?? '').split(delimiter)[0], 'C:\\real')
})

test('buildEnv: does not create a duplicate PATH/Path key', () => {
  const env = buildEnv(['C:\\x'])
  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path')
  assert.equal(pathKeys.length, Object.keys(process.env).filter((k) => k.toLowerCase() === 'path').length)
})

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
