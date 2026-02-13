import { createUnplugin } from 'unplugin';
import type { PhantomPluginOptions } from './types.js';
import { analyzeModule } from './analyzer.js';

export const phantom = createUnplugin((options: PhantomPluginOptions = {}) => {
  return {
    name: 'phantom',
    enforce: 'pre' as const,

    transformInclude(id: string) {
      return /\.[jt]sx?$/.test(id) && !id.includes('node_modules');
    },

    transform(code: string, id: string) {
      const result = analyzeModule(code, id, options);

      if (result.hasServerExtractions && result.clientCode) {
        return { code: result.clientCode, map: null };
      }

      return null;
    },
  };
});
