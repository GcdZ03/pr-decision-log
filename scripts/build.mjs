import { build } from 'esbuild';

await build({
  entryPoints: ['src/pdl.ts'],
  outfile: 'dist/pdl.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // No shebang banner: src/pdl.ts already carries one and esbuild preserves
  // it. Adding a second put one on line 2, where it is a syntax error, so the
  // built binary could not run at all.
  logLevel: 'info',
});
