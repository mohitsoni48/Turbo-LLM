import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDirName, CMAKE_CONFIGURE_ARGS, pickGenerator, vcvarsBatch, stripGenericAsmLanguage } from './build-runner'

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

test('stripGenericAsmLanguage: removes ASM from a project() language list (TurboQuant case)', () => {
  const { text, changed } = stripGenericAsmLanguage('project("ggml" C CXX ASM)\nset(X 1)')
  assert.equal(changed, true)
  assert.match(text, /project\("ggml" C CXX\)/)
  assert.ok(!/\bASM\b/.test(text))
})

test('stripGenericAsmLanguage: handles unquoted project name + extra spacing', () => {
  const { text } = stripGenericAsmLanguage('project(ggml-htp C CXX ASM)')
  assert.equal(text, 'project(ggml-htp C CXX)')
})

test('stripGenericAsmLanguage: comments out a standalone enable_language(ASM)', () => {
  const { text, changed } = stripGenericAsmLanguage('    enable_language(ASM)')
  assert.equal(changed, true)
  assert.match(text, /^#\s+enable_language\(ASM\)/)
})

test('stripGenericAsmLanguage: leaves CMake without ASM untouched', () => {
  const src = 'project("ggml" C CXX)\nenable_language(CUDA)\n'
  const { text, changed } = stripGenericAsmLanguage(src)
  assert.equal(changed, false)
  assert.equal(text, src)
})

test('stripGenericAsmLanguage: does not touch unrelated tokens containing the letters ASM', () => {
  const { text, changed } = stripGenericAsmLanguage('set(MY_WASM_FLAG ON)')
  assert.equal(changed, false)
  assert.ok(text.includes('MY_WASM_FLAG'))
})
