import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    entry: { treg: 'bin/treg.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    sourcemap: true,
  },
]);
