// Consumer-facing type usage for the phantom plugin factory.
// Type-checked by ../plugin-types.unit.ts via tsconfig.types.json.
//
// The natural no-argument call (`phantom()`) must type-check: every option is
// optional, so requiring an argument is a papercut. These lines must all
// compile; if the factory's options become required again, tsc fails here.
import phantomVite from '../../src/vite.js';
import { phantom } from '../../src/plugin.js';

// No-argument construction — the case that previously failed (TS2554).
phantomVite();
phantom.vite();
phantom.webpack();
phantom.rspack();

// With options — must keep working.
phantomVite({});
phantomVite({ enableLazy: false, minHandlerSize: 0, silent: true });
phantom.vite({ ssr: true });

export {};
