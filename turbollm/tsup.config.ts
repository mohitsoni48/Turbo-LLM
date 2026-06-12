import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  clean: true,
  target: 'node22',
  // node:sqlite is a Node 22+ built-in; mark explicitly external so the
  // node: prefix is preserved in the bundle (esbuild strips it otherwise).
  external: ['node:sqlite'],
  noExternal: [],
})
