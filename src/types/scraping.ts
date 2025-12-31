import { HTTPRequest, HTTPResponse } from "puppeteer";

export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  format?: string;
  description?: string;
}

export interface ExtractionSelector {
  selector: string; // CSS selector, XPath, or JSONPath
  type?: "text" | "attr" | "html" | "jsonpath"; // Extraction type
  attribute?: string; // For attr type, which attribute to extract
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
    selectors: Record<string, string | ExtractionSelector>; // Field -> selector mapping
  };

  // For JSON responses
  jsonPath?: {
    rootPath?: string; // Path to data root (e.g., "$.data.items")
    fieldPaths: Record<string, string>; // Field -> JSONPath mapping
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
  detectedPattern?: "page" | "offset" | "cursor" | "none";
  examples?: string[];
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
