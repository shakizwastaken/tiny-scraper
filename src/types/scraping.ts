import { HTTPRequest, HTTPResponse } from "puppeteer";

export interface JSONSchema {
  type?: string | string[]; // Support multiple types or single type
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema | JSONSchema[]; // Support tuple types with array of schemas
  required?: string[];
  format?: string;
  description?: string;
  // Advanced JSON Schema features
  anyOf?: JSONSchema[];
  allOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  not?: JSONSchema;
  enum?: (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  additionalProperties?: boolean | JSONSchema;
  patternProperties?: Record<string, JSONSchema>;
  // Array constraints
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  // String constraints
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  // Number constraints
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  multipleOf?: number;
  // Nullable support
  nullable?: boolean;
}

export interface ExtractionSelector {
  selector: string; // CSS selector, XPath, or JSONPath
  type?: "text" | "attr" | "html" | "jsonpath"; // Extraction type
  attribute?: string; // For attr type, which attribute to extract
}

/**
 * Configuration for nested array extraction (unlimited recursive depth)
 * Supports arrays within arrays within arrays... at any depth
 */
export interface NestedExtractionConfig {
  type: "array";
  containerSelector: string; // Selector to find container elements for this array level
  selectors: Record<
    string,
    string | ExtractionSelector | NestedExtractionConfig
  >; // Field -> selector mapping (can be nested)
  // For JSONPath-based extraction
  jsonPath?: string; // JSONPath expression to find the array
  // Metadata
  description?: string;
  minItems?: number;
  maxItems?: number;
}

export interface ScrapingInstructions {
  method: string;
  baseUrl: string;
  responseType: "json" | "html" | "xml";
  outputType: "array" | "object";

  // For HTML/XML responses
  extraction?: {
    type: "css" | "xpath" | "jsonpath" | "mixed";
    containerSelector?: string; // For arrays: selector for each item
    selectors: Record<
      string,
      string | ExtractionSelector | NestedExtractionConfig
    >; // Field -> selector mapping (supports unlimited nested arrays)
  };

  // For JSON responses
  jsonPath?: {
    rootPath?: string; // Path to data root (e.g., "$.data.items")
    fieldPaths: Record<string, string | NestedExtractionConfig>; // Field -> JSONPath mapping (supports unlimited nested arrays)
  };

  // Output schema (JSON Schema format) - generated automatically from extracted data
  schema?: JSONSchema;

  // Pagination
  pagination?: {
    type: "query" | "body" | "header" | "response";
    location: string; // e.g., "query.page", "body.offset", "response.nextPage"
    placeholder: string; // e.g., "{{page}}", "{{offset}}"
    initialValue?: string | number;
  };

  // Request structure
  body?: {
    structure: Record<string, any>; // JSON structure with placeholders
    placeholders: string[]; // List of placeholder keys
  };
  queryParams?: {
    structure: Record<string, any>;
    placeholders: string[];
  };
  headers?: {
    dynamic: Record<string, string>; // Headers that might need placeholders
    static: Record<string, string>; // Static headers
  };
  cookies?: string; // Cookie string to send with requests (format: "name=value; name2=value2")
}

export interface RequestMetadata {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  scrapingInstructions?: ScrapingInstructions;
  gptError?: string;
}

export interface InterceptedRequest {
  request: HTTPRequest;
  response?: HTTPResponse;
  responseBody?: string;
}

export interface TestResults {
  success: boolean;
  extractedData?: any; // Sample of extracted data
  errors?: string[];
  debugInfo?: Record<string, any>;
  paginationTestResult?: {
    tested: boolean;
    passed?: boolean;
    error?: string;
  };
}

export interface RefinementResponse {
  ok: boolean;
  modification?: ScrapingInstructions;
  reason?: string; // Optional explanation
}

export interface PaginationHints {
  queryParams?: Record<string, string>;
  bodyParams?: Record<string, any>;
  urlPattern?: string;
  hasPaginationControls?: boolean;
  detectedPattern?:
    | "page"
    | "offset"
    | "cursor"
    | "scroll"
    | "time"
    | "token"
    | "graphql"
    | "hybrid"
    | "none";
  examples?: string[];
  uiElements?: PaginationUIElement[];
  testResults?: PaginationTestResult[];
  candidates?: PaginationCandidate[];
  // Additional detection hints
  infiniteScroll?: boolean;
  graphQLCursor?: boolean;
  timeBased?: boolean;
  tokenBased?: boolean;
  hybridPagination?: boolean;
}

export interface PaginationUIElement {
  type: "button" | "link" | "scroll";
  selector: string;
  text?: string;
  href?: string;
  onClick?: string;
  dataAttributes?: Record<string, string>;
  detectedMethod: "css" | "text" | "data-attr" | "aria";
}

export interface PaginationCandidate {
  type: "query" | "body" | "header" | "response" | "ui" | "scroll";
  location: string; // e.g., "query.page", "body.pagination.page", "ui.button.loadMore"
  paramName?: string;
  pattern: "page" | "offset" | "cursor" | "scroll";
  confidence: number; // 0-1
  examples?: string[];
  testResults?: PaginationTestResult;
  initialValue?: string | number;
  placeholder?: string;
}

export interface PaginationTestResult {
  pattern: PaginationCandidate;
  tested: boolean;
  passed: boolean;
  error?: string;
  firstPageDifferent?: boolean;
  page1Results?: any;
  page2Results?: any;
  itemCounts?: { page1: number; page2: number };
  hasMoreDetected?: boolean;
  confidence: number; // 0-1 score
}

export interface PaginationAnalysisResult {
  candidates: PaginationCandidate[];
  bestCandidate?: PaginationCandidate;
  allHints: PaginationHints;
  testResults: PaginationTestResult[];
  firstPageBehavior?: {
    different: boolean;
    preferredApproach: "no-param" | "explicit-param";
  };
}

export interface PaginationContext {
  url?: string;
  method?: string;
  responseType?: "json" | "html" | "xml";
  headers?: Record<string, string>;
  body?: any;
}

export interface ExtractionDebugInfo {
  selectorMatches?: Record<string, number>;
  fieldExtractionStats?: Record<
    string,
    { success: number; failed: number; nullCount: number }
  >;
  containerCount?: number;
  itemsExtracted?: number;
  containerHtmlSamples?: string[]; // Sample HTML from container elements (first 3 containers, max 2000 chars each)
}

export interface RequestSelectionResult {
  selectedIndex: number;
  reasoning: string;
  scores?: Record<
    number,
    {
      dataQuality: number;
      completeness: number;
      relevance: number;
      contentType: number;
      total: number;
    }
  >;
}

export interface IterationRecord {
  iteration: number;
  instructions: ScrapingInstructions;
  testResults: TestResults;
}
