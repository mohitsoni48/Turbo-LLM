import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDirName, CMAKE_CONFIGURE_ARGS, pickGenerator, vcvarsBatch } from './build-runner'

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

test('pickGenerator: Ninja when available, NMake fallback otherwise', () => {
  assert.equal(pickGenerator(true), 'Ninja')
  assert.equal(pickGenerator(false), 'NMake Makefiles')
})

test('vcvarsBatch: calls vcvars x64, then cmake, quotes spaced args, propagates exit code', () => {
  const bat = vcvarsBatch('C:\\Program Files\\VC\\vcvarsall.bat', ['-G', 'NMake Makefiles', '-B', 'C:\\b dir'])
  const lines = bat.split('\r\n')
  assert.equal(lines[0], '@echo off')
  assert.equal(lines[1], 'call "C:\\Program Files\\VC\\vcvarsall.bat" x64')
  assert.equal(lines[2], 'if errorlevel 1 exit /b 1')
  // spaced args quoted, unspaced left bare
  assert.equal(lines[3], 'cmake -G "NMake Makefiles" -B "C:\\b dir"')
  assert.equal(lines[4], 'exit /b %errorlevel%')
})

test('vcvarsBatch: leaves space-free args unquoted', () => {
  const bat = vcvarsBatch('C:\\vc.bat', ['-G', 'Ninja', '-DGGML_CUDA=ON'])
  assert.ok(bat.includes('cmake -G Ninja -DGGML_CUDA=ON'))
})
