/**
 * Phantom runtime — lazy-loads extracted event handler chunks.
 *
 * On first invocation, dynamically imports the chunk module and executes the handler.
 * Subsequent invocations use the cached function for instant execution.
 *
 * Key guarantees:
 * - Errors are logged (never swallowed silently)
 * - Rapid invocations are deduplicated (single import, multiple executions)
 * - Failed imports are cleaned up so retries can work
 *
 * Note: Synchronous event operations (preventDefault, stopPropagation) are
 * handled by the build-time synchronous prelude in the stub, NOT by this runtime.
 *
 * The import factory (() => import('phantom:seg_xxx.chunk.js')) is generated
 * at build time in the client stub. This allows Rollup/Vite to statically
 * analyze the dynamic import and emit the chunk as a separate file.
 */

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
const cache = new Map<string, Function>();
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
const pending = new Map<string, Promise<Function>>();

/**
 * Lazy-load and execute an extracted event handler chunk.
 *
 * @param factory - Import factory that returns a dynamic import promise.
 *                  Generated at build time: () => import('phantom:seg_xxx.chunk.js')
 * @param segmentId - The content-hashed segment ID (e.g., "seg_abc123")
 * @param args - The original function arguments + captured variables from outer scope
 */
export function __phantom_lazy(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: () => Promise<any>,
  segmentId: string,
  ...args: unknown[]
): void {
  // Fast path: handler already loaded and cached
  const cached = cache.get(segmentId);
  if (cached) {
    cached(...args);
    return;
  }

  // Deduplicate: if import is already in-flight, queue execution on its resolution
  const inflight = pending.get(segmentId);
  if (inflight) {
    inflight
      .then((fn) => fn(...args))
      .catch(handleError(segmentId));
    return;
  }

  // First invocation: call the factory to start the dynamic import
  const promise = factory()
    .then((mod: Record<string, unknown>) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
      const fn = mod[segmentId] as Function;
      cache.set(segmentId, fn);
      pending.delete(segmentId);
      return fn;
    });

  pending.set(segmentId, promise);

  // Execute when the import resolves (with error handling)
  promise
    .then((fn) => fn(...args))
    .catch(handleError(segmentId));
}

/**
 * Create an error handler for a segment import failure.
 * Cleans up the pending state so a retry can work.
 */
function handleError(segmentId: string): (err: unknown) => void {
  return (err: unknown) => {
    pending.delete(segmentId);
    console.error(`[phantom] Failed to load handler chunk "${segmentId}":`, err);
  };
}
