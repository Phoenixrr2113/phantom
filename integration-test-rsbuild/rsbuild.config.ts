import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import phantom from 'phantom-build/rspack';

export default defineConfig({
  plugins: [pluginReact()],
  tools: {
    rspack: {
      plugins: [phantom({ minHandlerSize: 0 })],
    },
  },
  output: {
    sourceMap: { js: 'source-map' },
    minify: false,
  },
});
