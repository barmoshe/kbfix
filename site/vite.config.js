import { defineConfig } from 'vite';

// The site imports the plugin's REAL engine from ../scripts/lib, so the
// playground cannot drift from what the CLI and the hook actually do. Those
// modules are pure (no node:fs), which is what makes this possible.
export default defineConfig({
  base: './',
  server: { fs: { allow: ['..'] } },
  build: { outDir: 'dist', emptyOutDir: true },
});
