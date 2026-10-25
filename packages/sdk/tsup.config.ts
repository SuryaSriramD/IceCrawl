import { defineConfig } from 'tsup';

// The workspace packages are inlined; third-party packages stay external (they are this package's dependencies).
export default defineConfig({
  entry: { index: 'src/index.ts', verify: 'src/verify.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: true,
  clean: true,
  noExternal: [/^@icecrawl\//],
});
