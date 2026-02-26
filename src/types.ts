import type { Program } from 'estree';

/** Classification of a code segment */
export type SegmentClassification =
  | 'PureComputation'
  | 'EventHandler'
  | 'ClientInteractive'
  | 'Shared'
  | 'Ambiguous';

/** A classified code segment within a module */
export interface ClassifiedSegment {
  /** Content-hashed unique identifier */
  id: string;
  /** Human-readable name (e.g., "ProductPage_useMemo_0") */
  name: string;
  /** Classification result */
  classification: SegmentClassification;
  /** Confidence score from 0.0 to 1.0 */
  confidence: number;
  /** Human-readable reasons for the classification */
  reasons: string[];
  /** Identifiers this segment depends on */
  dependencies: string[];
  /** Source location */
  span: { start: number; end: number };
}

/** Variable dependency information for a function */
export interface FunctionDependency {
  /** Function name (or "<anonymous>") */
  name: string;
  /** Variables declared locally in this function */
  locals: string[];
  /** Variables captured from an outer scope */
  captured: string[];
  /** Variables imported from other modules */
  imported: string[];
  /** Global/browser variables referenced */
  globals: string[];
  /** Source location */
  span: { start: number; end: number };
}

/** Result of analyzing a single module */
export interface AnalyzedModule {
  /** File path */
  path: string;
  /** Parsed AST */
  ast: Program;
  /** All functions/closures found and their dependencies */
  functions: FunctionDependency[];
  /** All import sources */
  imports: ImportInfo[];
  /** Re-exports: `export { X } from './X'` pass-through mappings */
  reExports: ReExportMapping[];
}

/** A single re-export mapping: `export { importedName as exportedName } from source` */
export interface ReExportMapping {
  /** The name exported from this module */
  exportedName: string;
  /** The name imported from the source module (e.g., "default" for `export { default as Foo }`) */
  importedName: string;
  /** The source module specifier */
  source: string;
}

/** Import information */
export interface ImportInfo {
  /** Module specifier (e.g., "react", "./utils") */
  source: string;
  /** Imported bindings */
  specifiers: Array<{
    local: string;
    imported: string | null;
    kind: 'named' | 'default' | 'namespace';
  }>;
}

/** Source map output from esrap's print() */
export interface SourceMapLike {
  version: number;
  sources: string[];
  sourcesContent: string[];
  mappings: string;
  names: string[];
}

/** Result of full classification + extraction */
export interface AnalysisResult {
  /** Original file path */
  path: string;
  /** Classified segments */
  segments: ClassifiedSegment[];
  /** Whether any extractions were made */
  hasExtractions: boolean;
  /** Transformed client code (if extractions were made) */
  clientCode?: string;
  /** Source map for transformed client code */
  clientMap?: SourceMapLike;
  /** Generated lazy-loaded chunk modules (grouped: one module per source file) */
  chunkModules?: Array<{ id: string; code: string; map: SourceMapLike }>;
  /** Individual segment IDs within the grouped chunk module */
  extractedSegmentIds?: string[];
  /** Lazy component candidates (components that should be React.lazy wrapped) */
  lazyCandidates?: LazyCandidate[];
  /** Components kept static with reasons */
  lazyKeptStatic?: Array<{ localName: string; source: string; reason: string }>;
}

/** Prefetch strategy for lazy-loaded components */
export type PrefetchStrategy = 'immediate' | 'viewport' | 'interaction' | 'idle';

/**
 * A child component import that should be wrapped in React.lazy + Suspense.
 * Produced by the lazy detection pass in classify/lazy.ts.
 */
export interface LazyCandidate {
  /** Local binding name (e.g., "PaymentForm") */
  localName: string;
  /** Original import source as written in the module (e.g., "./components") */
  source: string;
  /**
   * Resolved import source for the dynamic import, after barrel file resolution.
   * When null/undefined, falls back to `source`.
   * E.g., if `source` is "./components" (barrel) and the barrel re-exports
   * PaymentForm from "./PaymentForm", resolvedSource is "./components/PaymentForm".
   */
  resolvedSource?: string;
  /** Whether the original import was default, named, or namespace */
  importKind: 'default' | 'named' | 'namespace';
  /** For named imports, the exported name from the source module */
  importedName: string | null;
  /** All JSX locations where this component is used */
  jsxUsages: Array<{ start: number; end: number }>;
  /** Recommended loading strategy */
  prefetch: PrefetchStrategy;
  /**
   * Group ID for components that should share a Suspense boundary.
   * null = gets its own boundary.
   */
  suspenseGroup: string | null;
  /** Whether this component is conditionally rendered */
  conditional: boolean;
  /** Render order position in the parent JSX container (0-indexed) */
  jsxPosition: number;
  /** Human-readable reason for the decision */
  reason: string;
}

/** Result of lazy candidate detection */
export interface LazyCandidateResult {
  /** Components that should be lazified */
  lazy: LazyCandidate[];
  /** Components kept static, with reasons */
  keepStatic: Array<{
    localName: string;
    source: string;
    reason: string;
  }>;
}

/**
 * Cross-module component profile for informing lazy detection.
 * Built from analyzing the imported component's module.
 */
export interface ComponentProfile {
  /** Whether the component declares event handlers */
  hasHandlers: boolean;
  /** Whether the component uses useState/useReducer */
  hasState: boolean;
  /** Whether the component uses useEffect/useLayoutEffect */
  hasEffects: boolean;
  /** Number of event handlers in the component */
  handlerCount: number;
  /** Whether the component exports a React context (createContext) */
  providesContext: boolean;
  /** Estimated JS bundle size in bytes (0 if unknown) */
  estimatedSize: number;
}

// ── SSR Boundary Detection Types ──────────────────────────────────────

/** SSR classification for a React component */
export type SSRClassification = 'FullyStatic' | 'SSRSafe' | 'ClientOnly';

/** Result of SSR boundary analysis for a single component */
export interface SSRComponentResult {
  /** Component function name */
  name: string;
  /** SSR classification */
  classification: SSRClassification;
  /** Confidence score 0.0–1.0 */
  confidence: number;
  /** Human-readable reasons */
  reasons: string[];
  /** Browser APIs found in the render path (empty = SSR-safe) */
  renderPathBrowserAPIs: string[];
  /** Hooks used by this component */
  hooks: string[];
  /** Whether the component has typeof window guards */
  hasWindowGuards: boolean;
}

/** Result of SSR boundary analysis for a module */
export interface SSRModuleResult {
  /** All components analyzed */
  components: SSRComponentResult[];
  /** Whether the module has top-level browser API access */
  hasTopLevelBrowserAccess: boolean;
  /** Top-level browser APIs (outside any function) */
  topLevelBrowserAPIs: string[];
}

/** Plugin configuration options */
export interface PhantomPluginOptions {
  /** Confidence threshold — below this, leave on client (default: 0.8) */
  confidenceThreshold?: number;
  /** Output path for manifest (default: "phantom.manifest.json") */
  manifestPath?: string;
  /** Suppress build summary output (default: false) */
  silent?: boolean;
  /** Enable React.lazy + Suspense wrapping for child components (default: true) */
  enableLazy?: boolean;
  /** Component profiles from prior analysis (for cross-module awareness) */
  componentProfiles?: Map<string, ComponentProfile>;
  /** Cerebras API key for LLM-assisted lazy optimization (optional) */
  cerebrasApiKey?: string;
  /** Cerebras model ID (default: "qwen-3-32b") */
  cerebrasModel?: string;
  /**
   * SSR mode — skip all transforms so the server bundle gets original code
   * untouched for synchronous renderToString(). Default: false.
   *
   * In custom SSR setups, run two bundler instances:
   *   - Client build: phantom() (full transforms)
   *   - Server build: phantom({ ssr: true }) (no-op)
   */
  ssr?: boolean;
  /**
   * Automatically detect SSR boundaries for components.
   * - 'auto': Analyze and add to manifest (report-only)
   * - 'annotate': Prepend "use client" to ClientOnly modules
   * - false: Disabled (default)
   */
  ssrBoundaries?: 'auto' | 'annotate' | false;
}

/** A single entry in the Phantom manifest */
export interface ManifestEntry {
  /** Content-hashed segment ID */
  segmentId: string;
  /** Original source file */
  sourceFile: string;
  /** Virtual module ID for the chunk module */
  virtualId: string;
  /** Human-readable segment name */
  name: string;
  /** Type of extraction */
  kind: 'handler' | 'lazy';
}

/** The full Phantom build manifest */
export interface PhantomManifest {
  version: 1;
  entries: ManifestEntry[];
  stats: {
    totalModulesProcessed: number;
    totalSegmentsExtracted: number;
  };
  /** SSR boundary analysis results (when ssrBoundaries option is enabled) */
  ssrBoundaries?: Array<{
    sourceFile: string;
    components: SSRComponentResult[];
  }>;
}
