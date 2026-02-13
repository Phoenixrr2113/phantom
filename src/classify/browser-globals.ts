/**
 * Browser-only global identifiers.
 * If a function references any of these (unresolved), it must stay on the client.
 */
export const BROWSER_GLOBALS = new Set([
  // Window / global
  'window',
  'self',
  'globalThis',

  // DOM
  'document',
  'navigator',
  'location',
  'history',
  'screen',

  // Storage
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',

  // Timers / Animation
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',

  // Observers
  'IntersectionObserver',
  'MutationObserver',
  'ResizeObserver',
  'PerformanceObserver',

  // Web APIs
  'fetch', // Note: fetch exists on server too, but may be overridden — keep configurable
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'BroadcastChannel',
  'MessageChannel',
  'Worker',
  'SharedWorker',
  'ServiceWorker',

  // Media
  'Audio',
  'Image',
  'MediaRecorder',
  'MediaStream',

  // DOM constructors
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'TouchEvent',
  'DragEvent',
  'ClipboardEvent',
  'FocusEvent',

  // Other browser-specific
  'alert',
  'confirm',
  'prompt',
  'print',
  'getComputedStyle',
  'matchMedia',
  'atob',
  'btoa',
  'queueMicrotask',
  'structuredClone',
  'crypto',
  'performance',
  'Notification',
  'Clipboard',
]);

/**
 * "Safe" globals that are pure computation — NOT browser-specific.
 * These exist in all JS environments (Node.js, Deno, browsers).
 * Functions referencing ONLY these are still server-compute candidates.
 */
export const PURE_GLOBALS = new Set([
  // Math & Numbers
  'Math',
  'Number',
  'BigInt',
  'NaN',
  'Infinity',
  'isNaN',
  'isFinite',
  'parseInt',
  'parseFloat',

  // Strings
  'String',
  'RegExp',

  // Collections
  'Array',
  'Object',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'WeakRef',

  // Structured data
  'JSON',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Uint8Array',
  'Uint16Array',
  'Uint32Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',

  // Error types
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',

  // Other pure builtins
  'Symbol',
  'Proxy',
  'Reflect',
  'Promise',
  'Date',
  'Boolean',
  'Function',
  'undefined',
  'null',
  'true',
  'false',
  'console', // debatable, but console.log is a side effect we'll allow
  'encodeURI',
  'encodeURIComponent',
  'decodeURI',
  'decodeURIComponent',
]);

/**
 * Check if an unresolved global reference is a browser-only API.
 */
export function isBrowserGlobal(name: string): boolean {
  return BROWSER_GLOBALS.has(name);
}

/**
 * Check if an unresolved global reference is a safe pure builtin.
 */
export function isPureGlobal(name: string): boolean {
  return PURE_GLOBALS.has(name);
}
