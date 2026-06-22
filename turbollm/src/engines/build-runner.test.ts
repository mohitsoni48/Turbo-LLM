import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDirName, CMAKE_CONFIGURE_ARGS } from './build-runner'

test('buildDirName: repo name from a .git URL, branch appended', () => {
  assert.equal(buildDirName('https://github.com/ikawrakow/ik_llama.cpp.git', 'sidestream'), 'ik_llama.cpp-sidestream')
})

test('buildDirName: no branch → bare repo name; trailing slash + .git stripped', () => {
  assert.equal(buildDirName('https://github.com/ggml-org/llama.cpp'), 'llama.cpp')
  assert.equal(buildDirName('https://github.com/ggml-org/llama.cpp.git/'), 'llama.cpp')
})

test('buildDirName: sanitizes unsafe chars in branch to single dashes', () => {
  assert.equal(buildDirName('https://github.com/owner/repo', 'feature/foo bar'), 'repo-feature-foo-bar')
})

test('buildDirName: unparseable URL falls back to "engine"', () => {
  assert.equal(buildDirName(''), 'engine')
  assert.equal(buildDirName('   '), 'engine')
})

test('CMAKE_CONFIGURE_ARGS: enables CUDA + Release', () => {
  assert.deepEqual(CMAKE_CONFIGURE_ARGS, ['-DGGML_CUDA=ON', '-DCMAKE_BUILD_TYPE=Release'])
})
