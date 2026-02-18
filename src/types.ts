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
  /** Generated lazy-loaded chunk modules */
  chunkModules?: Array<{ id: string; code: string; map: SourceMapLike }>;
}

/** Plugin configuration options */
export interface PhantomPluginOptions {
  /** Confidence threshold — below this, leave on client (default: 0.8) */
  confidenceThreshold?: number;
  /** Output path for manifest (default: "phantom.manifest.json") */
  manifestPath?: string;
  /** Suppress build summary output (default: false) */
  silent?: boolean;
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
}

/** The full Phantom build manifest */
export interface PhantomManifest {
  version: 1;
  entries: ManifestEntry[];
  stats: {
    totalModulesProcessed: number;
    totalSegmentsExtracted: number;
  };
}
