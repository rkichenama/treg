import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    entry: { treg: 'bin/treg.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: true,
  },
]);
