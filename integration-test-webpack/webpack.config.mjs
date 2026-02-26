import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import phantom from 'phantom-build/webpack';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('webpack').Configuration} */
export default {
  mode: 'development',
  devtool: 'source-map',
  entry: './src/index.tsx',
  output: {
    path: resolve(__dirname, 'dist'),
    filename: 'main.js',
    clean: true,
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: 'ts-loader',
          options: {
            // Phantom transforms code before ts-loader sees it.
            // The transformed code has dynamic imports to phantom: URIs
            // that TypeScript can't resolve — skip type checking here.
            transpileOnly: true,
          },
        },
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [
    phantom({ minHandlerSize: 0 }),
  ],
};
