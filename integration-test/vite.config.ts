import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import phantom from 'phantom-build/vite';

export default defineConfig({
  plugins: [
    phantom(),
    react(),
  ],
  build: {
    // Write output so we can inspect it
    outDir: 'dist',
    // Don't minify so we can read the output
    minify: false,
    // Generate source maps for debugging
    sourcemap: true,
  },
});
