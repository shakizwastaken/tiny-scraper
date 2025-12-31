import { JSONPath } from "jsonpath-plus";
import * as cheerio from "cheerio";
import { type ScrapingInstructions } from "../types";
import {
  getScrapingInstructions,
  saveScrapeResult,
  type ScrapingInstructionMetadata,
} from "./storage.service";
import { logExtractionDebugInfo } from "./debug.service";
import type { ExtractionDebugInfo } from "../types/scraping";
import { FETCH_TIMEOUT } from "../config";
import { BrowserService } from "./browser.service";

export interface PaginationOptions {
  page?: number;
  limit?: number;
  offset?: number;
  [key: string]: number | undefined;
}

export interface ScrapeResult {
  data: any;
  pagination?: {
    page?: number;
    limit?: number;
    offset?: number;
    hasMore?: boolean;
  };
}

/**
 * Apply pagination to instructions based on pagination options
 */
function applyPagination(
  instructions: ScrapingInstructions,
  options: PaginationOptions
): {
  url: string;
  body?: any;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
} {
  const { pagination } = instructions;
  if (!pagination) {
    return { url: instructions.baseUrl };
  }

  let url = instructions.baseUrl;
  let body: any = undefined;
  let headers: Record<string, string> = {};
  let queryParams: Record<string, string> = {};

  // Determine pagination value based on type
  let paginationValue: string | number | undefined;
  let isFirstPage = false;

  if (pagination.type === "query" || pagination.type === "body") {
    if (options.page !== undefined) {
      paginationValue = options.page;
      isFirstPage =
        options.page === 1 || options.page === pagination.initialValue;
    } else if (options.offset !== undefined) {
      paginationValue = options.offset;
      isFirstPage =
        options.offset === 0 || options.offset === pagination.initialValue;
    } else if (pagination.initialValue !== undefined) {
      paginationValue = pagination.initialValue;
      isFirstPage = true;
    } else {
      paginationValue = 1; // Default to page 1
      isFirstPage = true;
    }
  }

  // Check if first page should be handled differently (no param vs explicit param)
  // This would be set based on pagination analysis results
  // For now, we'll check if initialValue matches the current value
  const shouldSkipParamForFirstPage =
    isFirstPage &&
    pagination.initialValue !== undefined &&
    paginationValue === pagination.initialValue;

  // Apply pagination based on type
  if (pagination.type === "query") {
    const parts = pagination.location.split(".");
    const location = parts[0];
    const param = parts[1];
    if (location === "query" && param) {
      // Skip adding param for first page if it's handled differently
      if (!shouldSkipParamForFirstPage) {
        queryParams[param] = String(paginationValue);
      }
    }
  } else if (pagination.type === "body") {
    body = { ...instructions.body?.structure };
    const parts = pagination.location.split(".");
    const location = parts[0];
    const path = parts.slice(1);
    if (location === "body" && path.length > 0) {
      // Skip adding param for first page if it's handled differently
      if (!shouldSkipParamForFirstPage) {
        let current: any = body;
        for (let i = 0; i < path.length - 1; i++) {
          const pathKey = path[i];
          if (pathKey) {
            if (!current[pathKey]) {
              current[pathKey] = {};
            }
            current = current[pathKey];
          }
        }
        const lastKey = path[path.length - 1];
        if (lastKey) {
          current[lastKey] = paginationValue;
        }
      }
    }
  } else if (pagination.type === "header") {
    const parts = pagination.location.split(".");
    const location = parts[0];
    const headerName = parts[1];
    if (location === "header" && headerName) {
      // Skip adding header for first page if it's handled differently
      if (!shouldSkipParamForFirstPage) {
        headers[headerName] = String(paginationValue);
      }
    }
  }

  // Replace placeholders in query params
  // Handle both structure format and plain object format
  const queryParamsData =
    instructions.queryParams?.structure || instructions.queryParams;
  if (queryParamsData) {
    Object.entries(queryParamsData).forEach(([key, value]) => {
      if (typeof value === "string" && value.includes("{{")) {
        // Replace placeholders
        let replaced = value;
        if (pagination.placeholder && paginationValue !== undefined) {
          replaced = replaced.replace(
            pagination.placeholder,
            String(paginationValue)
          );
        }
        // If still contains placeholders, try common ones
        if (replaced.includes("{{date}}")) {
          // Default to today's date in YYYY-MM-DD format if not replaced
          const today = new Date().toISOString().split("T")[0] || "";
          replaced = replaced.replace("{{date}}", today);
        }
        // Only add if placeholder was replaced
        if (!replaced.includes("{{")) {
          queryParams[key] = replaced;
        }
      } else {
        queryParams[key] = String(value);
      }
    });
  }

  // Replace placeholders in body
  if (instructions.body?.structure) {
    body = JSON.parse(JSON.stringify(instructions.body.structure));
    const replacePlaceholders = (obj: any): any => {
      if (typeof obj === "string" && obj.includes("{{")) {
        if (pagination.placeholder && paginationValue !== undefined) {
          return obj.replace(pagination.placeholder, String(paginationValue));
        }
        return obj;
      }
      if (Array.isArray(obj)) {
        return obj.map(replacePlaceholders);
      }
      if (obj && typeof obj === "object") {
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
          result[key] = replacePlaceholders(value);
        }
        return result;
      }
      return obj;
    };
    body = replacePlaceholders(body);
  }

  // Build URL with query params
  if (Object.keys(queryParams).length > 0) {
    const urlObj = new URL(url);
    Object.entries(queryParams).forEach(([key, value]) => {
      urlObj.searchParams.set(key, value);
    });
    url = urlObj.toString();
  }

  return { url, body, headers, queryParams };
}

/**
 * Filter out invalid headers for HTTP/1.1 requests
 * Removes HTTP/2 pseudo-headers and other problematic headers
 */
function filterValidHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const filtered: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    // Skip HTTP/2 pseudo-headers (they start with :)
    if (key.startsWith(":")) {
      continue;
    }

    // Skip other problematic headers
    // 'priority' can sometimes cause issues
    if (key.toLowerCase() === "priority") {
      continue;
    }

    // Keep all other headers
    filtered[key] = value;
  }

  return filtered;
}

/**
 * Make HTTP request based on instructions
 */
async function makeRequest(
  instructions: ScrapingInstructions,
  paginationOptions: PaginationOptions
): Promise<string> {
  const { url, body, headers, queryParams } = applyPagination(
    instructions,
    paginationOptions
  );

  // Start with headers from instructions (these came from Puppeteer)
  // Priority: static headers (most reliable) > dynamic headers > pagination headers
  // Puppeteer headers take precedence - they're more accurate for bot protection
  const rawHeaders: Record<string, string> = {
    ...instructions.headers?.static, // These are the exact Puppeteer headers
    ...instructions.headers?.dynamic,
    ...headers, // Pagination-related headers
  };

  const requestHeaders = filterValidHeaders(rawHeaders);

  // Only add defaults if headers are truly missing
  // Don't override Puppeteer headers - they're more accurate
  if (!requestHeaders["User-Agent"]) {
    requestHeaders["User-Agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  }
  if (!requestHeaders["Accept"]) {
    requestHeaders["Accept"] =
      instructions.responseType === "json"
        ? "application/json, text/plain, */*"
        : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
  }

  // Only add these if they're missing - Puppeteer headers take precedence
  if (!requestHeaders["Accept-Language"]) {
    requestHeaders["Accept-Language"] = "en-US,en;q=0.9";
  }
  if (!requestHeaders["Accept-Encoding"]) {
    requestHeaders["Accept-Encoding"] = "gzip, deflate, br";
  }
  if (!requestHeaders["Referer"]) {
    // Set referer to the same domain if possible
    try {
      const urlObj = new URL(url);
      requestHeaders["Referer"] = `${urlObj.protocol}//${urlObj.host}/`;
    } catch {
      // If URL parsing fails, skip referer
    }
  }
  if (!requestHeaders["Sec-Fetch-Site"]) {
    requestHeaders["Sec-Fetch-Site"] = "none";
  }
  if (!requestHeaders["Sec-Fetch-Mode"]) {
    requestHeaders["Sec-Fetch-Mode"] = "navigate";
  }
  if (!requestHeaders["Sec-Fetch-User"]) {
    requestHeaders["Sec-Fetch-User"] = "?1";
  }
  if (!requestHeaders["Sec-Fetch-Dest"]) {
    requestHeaders["Sec-Fetch-Dest"] = "document";
  }
  if (!requestHeaders["Upgrade-Insecure-Requests"]) {
    requestHeaders["Upgrade-Insecure-Requests"] = "1";
  }
  if (!requestHeaders["Connection"]) {
    requestHeaders["Connection"] = "keep-alive";
  }

  // Add cookies if available in instructions
  if (instructions.cookies && !requestHeaders["Cookie"]) {
    requestHeaders["Cookie"] = instructions.cookies;
  }

  const requestOptions: RequestInit = {
    method: instructions.method,
    headers: requestHeaders,
  };

  if (
    body &&
    (instructions.method === "POST" ||
      instructions.method === "PUT" ||
      instructions.method === "PATCH")
  ) {
    requestOptions.body = JSON.stringify(body);
    if (!requestHeaders["Content-Type"]) {
      requestHeaders["Content-Type"] = "application/json";
    }
  }

  console.log(`Making ${instructions.method} request to: ${url}`);
  if (body) {
    console.log("Request body:", JSON.stringify(body, null, 2));
  }
  if (Object.keys(requestHeaders).length > 0) {
    console.log("Request headers:", requestHeaders);
  }

  // Add timeout wrapper
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Request timeout after ${FETCH_TIMEOUT}ms`)),
      FETCH_TIMEOUT
    );
  });

  // Retry logic with exponential backoff
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const fetchPromise = fetch(url, {
        ...requestOptions,
        redirect: "follow", // Follow redirects automatically
      });

      const response = await Promise.race([fetchPromise, timeoutPromise]);

      // Handle rate limiting (429) with exponential backoff
      if (response.status === 429) {
        if (attempt < maxRetries - 1) {
          const retryAfter = response.headers.get("Retry-After");
          const waitTime = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s

          console.log(
            `⚠️  Rate limited (429), waiting ${waitTime}ms before retry ${
              attempt + 1
            }/${maxRetries}...`
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          continue;
        } else {
          throw new Error(
            `Rate limited (429) after ${maxRetries} attempts. Retry-After: ${
              response.headers.get("Retry-After") || "N/A"
            }`
          );
        }
      }

      // If we get a 403, try using browser service as fallback
      if (response.status === 403) {
        console.log(
          "⚠️  Got 403 Forbidden, attempting fallback to browser service..."
        );
        let browserService: BrowserService | null = null;
        try {
          browserService = new BrowserService();
          await browserService.launchBrowser();
          const { page } = await browserService.setupPageWithInterception();

          // Navigate to the URL
          await browserService.navigateToUrl(page, url);

          // Get cookies from the page (they may be set during navigation)
          const cookies = await page.cookies();
          const cookieString = cookies
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; ");

          // Get the HTML content
          const html = await page.content();

          // Log cookie info for debugging
          if (cookieString) {
            console.log(
              `   ℹ️  Captured ${cookies.length} cookie(s) from browser session`
            );
          }

          await browserService.closeBrowser();
          console.log(
            "✅ Successfully retrieved content using browser service"
          );

          // Note: Cookies are captured but not automatically saved to instructions
          // The browser service fallback is a one-time workaround for 403 errors
          return html;
        } catch (browserError) {
          console.error(
            "❌ Browser service fallback also failed:",
            browserError
          );
          if (browserService) {
            await browserService.closeBrowser().catch(() => {});
          }
          throw new Error(
            `HTTP ${response.status}: ${response.statusText} - ${url}`
          );
        }
      }

      // Handle other error status codes
      if (!response.ok) {
        // Retry on 5xx errors (server errors)
        if (
          response.status >= 500 &&
          response.status < 600 &&
          attempt < maxRetries - 1
        ) {
          const waitTime = Math.pow(2, attempt) * 1000;
          console.log(
            `⚠️  Server error (${
              response.status
            }), waiting ${waitTime}ms before retry ${
              attempt + 1
            }/${maxRetries}...`
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          continue;
        }

        // Don't retry on 4xx errors (client errors)
        throw new Error(
          `HTTP ${response.status}: ${response.statusText} - ${url}`
        );
      }

      // Success - return response body
      const responseBody = await response.text();

      // Handle empty responses gracefully
      if (responseBody.length === 0) {
        console.warn("⚠️  Received empty response body");
      }

      return responseBody;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on timeout or network errors for last attempt
      if (attempt === maxRetries - 1) {
        throw lastError;
      }

      // Retry on network errors with exponential backoff
      if (error instanceof TypeError || error instanceof Error) {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(
          `⚠️  Request failed (${
            error.message
          }), waiting ${waitTime}ms before retry ${
            attempt + 1
          }/${maxRetries}...`
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }

      throw error;
    }
  }

  // Should not reach here, but just in case
  throw lastError || new Error("Request failed after all retries");
}

/**
 * Recursively extract field value from JSON data using JSONPath or nested extraction config
 * Supports unlimited recursive nested arrays
 */
function extractJSONField(
  data: any,
  fieldPath:
    | string
    | {
        type: string;
        jsonPath?: string;
        containerSelector?: string;
        selectors: Record<string, any>;
      },
  depth: number = 0
): any {
  // Safety limit to prevent infinite recursion
  const MAX_DEPTH = 100;
  if (depth > MAX_DEPTH) {
    console.warn(
      `Maximum JSON extraction depth (${MAX_DEPTH}) reached, returning null`
    );
    return null;
  }

  // Handle nested extraction config (unlimited recursive depth)
  if (
    typeof fieldPath === "object" &&
    fieldPath !== null &&
    "type" in fieldPath &&
    fieldPath.type === "array" &&
    ("jsonPath" in fieldPath || "containerSelector" in fieldPath) &&
    "selectors" in fieldPath
  ) {
    const nestedConfig = fieldPath as {
      type: string;
      jsonPath?: string;
      containerSelector?: string;
      selectors: Record<string, any>;
    };

    // Use JSONPath to find the array
    if (nestedConfig.jsonPath) {
      try {
        const arrayResults = JSONPath({
          path: nestedConfig.jsonPath,
          json: data,
        });
        if (Array.isArray(arrayResults) && arrayResults.length > 0) {
          const arrayData = Array.isArray(arrayResults[0])
            ? arrayResults[0]
            : arrayResults;

          // Recursively extract from each item in the array
          return arrayData.map((item: any) => {
            const nestedItem: Record<string, any> = {};
            Object.entries(nestedConfig.selectors).forEach(
              ([nestedFieldName, nestedFieldPath]) => {
                try {
                  nestedItem[nestedFieldName] = extractJSONField(
                    item,
                    nestedFieldPath,
                    depth + 1
                  );
                } catch (error) {
                  console.warn(
                    `Error extracting nested JSON field "${nestedFieldName}" at depth ${depth}:`,
                    error
                  );
                  nestedItem[nestedFieldName] = null;
                }
              }
            );
            return nestedItem;
          });
        }
      } catch (error) {
        console.warn(
          `Error processing nested JSONPath "${nestedConfig.jsonPath}":`,
          error
        );
        return [];
      }
    }
    return [];
  }

  // Handle simple JSONPath string
  if (typeof fieldPath === "string") {
    try {
      // Normalize and validate JSONPath
      const normalizedPath = normalizeJSONPath(fieldPath);
      if (!normalizedPath) {
        console.warn(`Invalid JSONPath: "${fieldPath}"`);
        return null;
      }

      const pathResults = JSONPath({ path: normalizedPath, json: data });
      if (pathResults.length > 0) {
        return pathResults[0];
      }
    } catch (error) {
      console.warn(`Error processing JSONPath "${fieldPath}":`, error);
      // Try to recover by checking if it's a simple property access
      if (fieldPath.startsWith("$.") && data && typeof data === "object") {
        const simplePath = fieldPath.replace(/^\$\./, "");
        try {
          const value = simplePath
            .split(".")
            .reduce((obj: any, key: string) => obj?.[key], data);
          if (value !== undefined) {
            return value;
          }
        } catch {
          // Ignore recovery attempt errors
        }
      }
    }
  }

  return null;
}

/**
 * Extract data from JSON response
 */
function extractFromJSON(
  body: string,
  instructions: ScrapingInstructions
): any {
  // Handle empty or malformed JSON gracefully
  if (!body || body.trim().length === 0) {
    throw new Error("Empty response body received");
  }

  let json: any;
  try {
    json = JSON.parse(body);
  } catch (error) {
    // Try to recover from common JSON issues
    const trimmed = body.trim();

    // Try to fix common issues
    let fixedBody = trimmed;

    // Remove BOM if present
    if (fixedBody.charCodeAt(0) === 0xfeff) {
      fixedBody = fixedBody.slice(1);
    }

    // Try to parse again
    try {
      json = JSON.parse(fixedBody);
    } catch (secondError) {
      // Try to extract JSON from HTML comments or script tags
      const jsonMatch = fixedBody.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
      if (jsonMatch && jsonMatch[1]) {
        try {
          json = JSON.parse(jsonMatch[1]);
        } catch {
          // Last resort: throw original error
          throw new Error(
            `Failed to parse JSON response: ${
              error instanceof Error ? error.message : String(error)
            }. ` + `Response preview: ${trimmed.substring(0, 200)}...`
          );
        }
      } else {
        throw new Error(
          `Failed to parse JSON response: ${
            error instanceof Error ? error.message : String(error)
          }. ` + `Response preview: ${trimmed.substring(0, 200)}...`
        );
      }
    }
  }

  const { jsonPath } = instructions;

  if (!jsonPath) {
    throw new Error("Missing jsonPath in instructions for JSON response");
  }

  // Get root data
  let rootData = json;
  if (jsonPath.rootPath) {
    try {
      const rootResults = JSONPath({ path: jsonPath.rootPath, json });
      if (rootResults.length > 0) {
        rootData = rootResults[0];
      }
    } catch (error) {
      console.warn(`Error processing rootPath "${jsonPath.rootPath}":`, error);
    }
  }

  if (instructions.outputType === "array") {
    // If rootData is an array, extract from each item
    if (Array.isArray(rootData)) {
      const debugInfo: ExtractionDebugInfo = {
        containerCount: rootData.length,
        selectorMatches: {},
        fieldExtractionStats: {},
      };

      // Initialize field stats
      Object.keys(jsonPath.fieldPaths).forEach((fieldName) => {
        debugInfo.fieldExtractionStats![fieldName] = {
          success: 0,
          failed: 0,
          nullCount: 0,
        };
      });

      const results = rootData.map((item) => {
        const itemResult: Record<string, any> = {};
        Object.entries(jsonPath.fieldPaths).forEach(
          ([fieldName, fieldPath]) => {
            try {
              const value = extractJSONField(item, fieldPath, 0);
              itemResult[fieldName] = value;

              const stats = debugInfo.fieldExtractionStats![fieldName];
              if (stats) {
                if (value === null || value === undefined) {
                  stats.failed++;
                  stats.nullCount++;
                } else {
                  stats.success++;
                }
              }
            } catch (error) {
              console.warn(`Error extracting field "${fieldName}":`, error);
              itemResult[fieldName] = null;
              const errorStats = debugInfo.fieldExtractionStats![fieldName];
              if (errorStats) {
                errorStats.failed++;
                errorStats.nullCount++;
              }
            }
          }
        );
        return itemResult;
      });

      debugInfo.itemsExtracted = results.length;
      logExtractionDebugInfo(debugInfo);

      return results;
    }

    // If rootData is not an array, log error and try to find array elsewhere
    console.error(
      `❌ ERROR: outputType is "array" but rootData at path "${
        jsonPath.rootPath || "$"
      }" is not an array. Got: ${typeof rootData}`
    );

    // Try to find array in the JSON structure - search common patterns
    const searchPaths = [
      "$.data[*]",
      "$.items[*]",
      "$.results[*]",
      "$.list[*]",
      "$[*]",
      "$.data.items[*]",
      "$.data.results[*]",
    ];

    for (const searchPath of searchPaths) {
      try {
        const arrayResults = JSONPath({ path: searchPath, json });
        if (
          Array.isArray(arrayResults) &&
          arrayResults.length > 0 &&
          Array.isArray(arrayResults[0])
        ) {
          console.log(`   ℹ️  Found array at path: ${searchPath}`);
          const arrayData = arrayResults[0];

          const debugInfo: ExtractionDebugInfo = {
            containerCount: arrayData.length,
            selectorMatches: {},
            fieldExtractionStats: {},
          };

          Object.keys(jsonPath.fieldPaths).forEach((fieldName) => {
            debugInfo.fieldExtractionStats![fieldName] = {
              success: 0,
              failed: 0,
              nullCount: 0,
            };
          });

          const results = arrayData.map((item: any) => {
            const itemResult: Record<string, any> = {};
            Object.entries(jsonPath.fieldPaths).forEach(
              ([fieldName, fieldPath]) => {
                try {
                  const value = extractJSONField(item, fieldPath, 0);
                  itemResult[fieldName] = value;

                  const stats = debugInfo.fieldExtractionStats![fieldName];
                  if (stats) {
                    if (value === null || value === undefined) {
                      stats.failed++;
                      stats.nullCount++;
                    } else {
                      stats.success++;
                    }
                  }
                } catch (error) {
                  console.warn(`Error extracting field "${fieldName}":`, error);
                  itemResult[fieldName] = null;
                  const errorStats = debugInfo.fieldExtractionStats![fieldName];
                  if (errorStats) {
                    errorStats.failed++;
                    errorStats.nullCount++;
                  }
                }
              }
            );
            return itemResult;
          });

          debugInfo.itemsExtracted = results.length;
          logExtractionDebugInfo(debugInfo);

          return results;
        }
      } catch (e) {
        // Continue searching
      }
    }

    // Last resort: if we can't find an array, throw an error
    throw new Error(
      `Cannot extract array: rootPath "${
        jsonPath.rootPath || "$"
      }" points to a ${typeof rootData}, not an array. ` +
        `Please check that the rootPath in jsonPath points to an array.`
    );
  }

  // Single object extraction
  const result: Record<string, any> = {};
  Object.entries(jsonPath.fieldPaths).forEach(([fieldName, fieldPath]) => {
    try {
      result[fieldName] = extractJSONField(rootData, fieldPath, 0);
      if (result[fieldName] === null || result[fieldName] === undefined) {
        result[fieldName] = null;
      }
    } catch (error) {
      console.warn(`Error extracting field "${fieldName}":`, error);
      result[fieldName] = null;
    }
  });

  return result;
}

/**
 * Strip pseudo-elements from a selector string
 * Removes ::text, ::attr(...), ::html, etc. from anywhere in the selector
 * Enhanced to handle more edge cases
 */
function stripPseudoElements(selector: string): string {
  if (!selector || typeof selector !== "string") return selector || "";

  // Remove ::text, ::html (at end or anywhere)
  selector = selector.replace(/::text\b/g, "");
  selector = selector.replace(/::html\b/g, "");
  // Remove ::attr(...) - matches ::attr(anything)
  selector = selector.replace(/::attr\([^)]*\)/g, "");
  // Remove other pseudo-elements that might interfere
  selector = selector.replace(/::before\b/g, "");
  selector = selector.replace(/::after\b/g, "");
  selector = selector.replace(/::first-child\b/g, "");
  selector = selector.replace(/::last-child\b/g, "");
  selector = selector.replace(/::nth-child\([^)]*\)/g, "");

  return selector.trim();
}

/**
 * Validate and normalize CSS selector
 */
function normalizeCSSSelector(selector: string): string {
  if (!selector || typeof selector !== "string") return "";

  // Remove leading/trailing whitespace
  selector = selector.trim();

  // Handle empty selectors
  if (selector.length === 0) return "";

  // Handle invalid characters (basic validation)
  // CSS selectors should not contain certain characters
  if (selector.includes("\n") || selector.includes("\r")) {
    selector = selector.replace(/[\n\r]/g, " ");
  }

  return selector;
}

/**
 * Validate and normalize JSONPath expression
 */
function normalizeJSONPath(path: string): string {
  if (!path || typeof path !== "string") return "";

  // Remove leading/trailing whitespace
  path = path.trim();

  // Ensure it starts with $ if it's a JSONPath
  if (path.length > 0 && !path.startsWith("$") && !path.startsWith("@")) {
    // Might be a relative path, try to make it absolute
    if (path.startsWith(".") || path.startsWith("[")) {
      path = "$" + path;
    }
  }

  return path;
}

/**
 * Extract data from HTML/XML response
 */
function extractFromHTML(
  body: string,
  instructions: ScrapingInstructions
): any {
  const $ = cheerio.load(body);
  const { extraction } = instructions;

  if (!extraction) {
    throw new Error("Missing extraction in instructions for HTML/XML response");
  }

  const parseSelector = (
    selector: string | { selector: string; type?: string; attribute?: string }
  ): { selector: string; type: string; attribute?: string } => {
    if (typeof selector === "string") {
      // Handle empty or invalid selectors
      if (!selector || selector.trim().length === 0) {
        return { selector: "", type: "text" };
      }

      // Parse format: "selector::text" or "selector::attr(name)" or "selector::html"
      const textMatch = selector.match(/^(.+)::text$/);
      const attrMatch = selector.match(/^(.+)::attr\(([^)]+)\)$/);
      const htmlMatch = selector.match(/^(.+)::html$/);

      if (textMatch && textMatch[1]) {
        const cleanSelector = normalizeCSSSelector(
          stripPseudoElements(textMatch[1])
        );
        return { selector: cleanSelector, type: "text" };
      } else if (attrMatch && attrMatch[1] && attrMatch[2]) {
        const cleanSelector = normalizeCSSSelector(
          stripPseudoElements(attrMatch[1])
        );
        return {
          selector: cleanSelector,
          type: "attr",
          attribute: attrMatch[2].trim(),
        };
      } else if (htmlMatch && htmlMatch[1]) {
        const cleanSelector = normalizeCSSSelector(
          stripPseudoElements(htmlMatch[1])
        );
        return { selector: cleanSelector, type: "html" };
      }

      // Default to text extraction
      const cleanSelector = normalizeCSSSelector(stripPseudoElements(selector));
      return { selector: cleanSelector, type: "text" };
    }

    // Handle object selector
    if (!selector || !selector.selector) {
      return { selector: "", type: "text" };
    }

    const cleanSelector = normalizeCSSSelector(
      stripPseudoElements(selector.selector)
    );
    return {
      selector: cleanSelector,
      type: selector.type || "text",
      attribute: selector.attribute,
    };
  };

  /**
   * Recursively extract field value from element
   * Supports unlimited recursive nested arrays (array -> array -> array -> ...)
   */
  const extractField = (
    element: cheerio.Cheerio<any>,
    fieldSelector: any,
    depth: number = 0
  ): any => {
    // Safety limit to prevent infinite recursion (should not be needed in practice)
    const MAX_DEPTH = 100;
    if (depth > MAX_DEPTH) {
      console.warn(
        `Maximum extraction depth (${MAX_DEPTH}) reached, returning null`
      );
      return null;
    }

    // Handle nested array extraction (unlimited recursive depth)
    if (
      typeof fieldSelector === "object" &&
      fieldSelector !== null &&
      "type" in fieldSelector &&
      fieldSelector.type === "array" &&
      ("containerSelector" in fieldSelector || "jsonPath" in fieldSelector) &&
      "selectors" in fieldSelector
    ) {
      const nestedExtraction = fieldSelector as {
        type: string;
        containerSelector?: string;
        jsonPath?: string;
        selectors: Record<string, any>;
      };

      // For HTML extraction, use containerSelector
      if (nestedExtraction.containerSelector) {
        const cleanContainerSelector = stripPseudoElements(
          nestedExtraction.containerSelector
        );
        const containers = element.find(cleanContainerSelector);
        const nestedResults: any[] = [];

        containers.each((_, nestedElement) => {
          const $nestedElement = $(nestedElement);
          const nestedItem: Record<string, any> = {};

          Object.entries(nestedExtraction.selectors).forEach(
            ([nestedFieldName, nestedFieldSelector]) => {
              try {
                // Recursively extract - this handles unlimited nesting
                nestedItem[nestedFieldName] = extractField(
                  $nestedElement,
                  nestedFieldSelector,
                  depth + 1
                );
              } catch (error) {
                console.warn(
                  `Error extracting nested field "${nestedFieldName}" at depth ${depth}:`,
                  error
                );
                nestedItem[nestedFieldName] = null;
              }
            }
          );

          nestedResults.push(nestedItem);
        });

        return nestedResults;
      }
    }

    // Handle relative selectors (starting with ::)
    if (typeof fieldSelector === "string" && fieldSelector.startsWith("::")) {
      const relativeSelector = fieldSelector.substring(2);
      if (relativeSelector.startsWith("attr(")) {
        const attrMatch = relativeSelector.match(/^attr\(([^)]+)\)$/);
        if (attrMatch && attrMatch[1]) {
          return element.attr(attrMatch[1]) || null;
        }
      } else if (relativeSelector === "text") {
        return element.text().trim();
      } else if (relativeSelector === "html") {
        return element.html() || null;
      } else {
        // Unknown relative selector
        return null;
      }
    }

    // Handle XPath ancestor selectors
    if (
      typeof fieldSelector === "string" &&
      fieldSelector.includes("ancestor::")
    ) {
      // XPath ancestor selector - cheerio doesn't support XPath
      // Try to find the ancestor using CSS selectors
      console.warn(
        `XPath selector "${fieldSelector}" is not fully supported. Attempting CSS alternative.`
      );
      const attrMatch = fieldSelector.match(/::attr\(([^)]+)\)$/);
      if (attrMatch && attrMatch[1]) {
        // Try to find a button ancestor
        const button = element.closest("button");
        if (button.length > 0) {
          return button.attr(attrMatch[1]) || null;
        }
      }
      return null;
    }

    // Handle simple selectors (CSS/XPath)
    const parsed = parseSelector(fieldSelector);

    // Handle empty selectors gracefully
    if (!parsed.selector || parsed.selector.length === 0) {
      console.warn("Empty selector encountered, returning null");
      return null;
    }

    try {
      const selected = element.find(parsed.selector).first();

      if (selected.length === 0) {
        // Selector didn't match anything
        return null;
      }

      if (parsed.type === "text") {
        const text = selected.text();
        return text ? text.trim() : null;
      } else if (parsed.type === "attr" && parsed.attribute) {
        return selected.attr(parsed.attribute) || null;
      } else if (parsed.type === "html") {
        return selected.html() || null;
      }

      // Default to text
      const text = selected.text();
      return text ? text.trim() : null;
    } catch (error) {
      console.warn(
        `Error extracting with selector "${parsed.selector}":`,
        error
      );
      return null;
    }
  };

  if (instructions.outputType === "array") {
    if (!extraction.containerSelector) {
      throw new Error("containerSelector is required for array output");
    }

    // Strip pseudo-elements from containerSelector before using it
    const cleanContainerSelector = stripPseudoElements(
      extraction.containerSelector
    );
    const containers = $(cleanContainerSelector);
    const results: any[] = [];

    console.log(
      `Found ${containers.length} container elements with selector: ${cleanContainerSelector}`
    );

    // Special handling for data-items attributes containing JSON
    // Check if any container has a data-items attribute with JSON data
    let dataItemsExtracted = false;
    containers.each((_, element) => {
      const $element = $(element);
      const dataItemsAttr = $element.attr("data-items");

      if (dataItemsAttr) {
        try {
          // Decode HTML entities
          const decoded = dataItemsAttr
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&#39;/g, "'")
            .replace(/&#x27;/g, "'")
            .replace(/&#x2F;/g, "/");

          // Parse JSON
          const jsonData = JSON.parse(decoded);

          if (Array.isArray(jsonData) && jsonData.length > 0) {
            console.log(
              `✅ Found ${jsonData.length} items in data-items attribute`
            );
            dataItemsExtracted = true;

            // Map JSON data to results using field selectors
            jsonData.forEach((item: any) => {
              const resultItem: Record<string, any> = {};

              Object.entries(extraction.selectors).forEach(
                ([fieldName, fieldSelector]) => {
                  try {
                    // Skip nested extraction configs (they're handled separately)
                    if (
                      fieldSelector &&
                      typeof fieldSelector === "object" &&
                      "type" in fieldSelector &&
                      fieldSelector.type === "array"
                    ) {
                      // Nested array extraction - skip for data-items extraction
                      return;
                    }

                    // For data-items, we need to map CSS selectors to JSON properties
                    // Strategy: Try fieldName first, then extract property from selector
                    const parsed = parseSelector(fieldSelector);

                    // If selector is a JSONPath-like expression, use it
                    if (
                      parsed.selector.startsWith("$.") ||
                      parsed.selector.startsWith("$[")
                    ) {
                      const pathResults = JSONPath({
                        path: parsed.selector,
                        json: item,
                      });
                      resultItem[fieldName] =
                        pathResults.length > 0 ? pathResults[0] : null;
                    } else {
                      // Try to extract property name from CSS selector
                      // Remove common CSS selector prefixes (.class, #id, etc.)
                      let propertyName = parsed.selector
                        .replace(/^\./, "") // Remove leading dot
                        .replace(/^#/, "") // Remove leading hash
                        .replace(/\[.*?\]/g, "") // Remove attribute selectors
                        .trim();

                      // Try multiple property name variations
                      resultItem[fieldName] =
                        item[fieldName] || // Direct field name match
                        item[propertyName] || // Property from selector
                        item[parsed.selector] || // Full selector as property
                        null;
                    }
                  } catch (error) {
                    console.warn(
                      `Error extracting field "${fieldName}" from data-items:`,
                      error
                    );
                    resultItem[fieldName] = null;
                  }
                }
              );

              results.push(resultItem);
            });
          }
        } catch (error) {
          console.warn("Failed to parse data-items attribute:", error);
        }
      }
    });

    // If we extracted from data-items, return early
    if (dataItemsExtracted) {
      console.log(
        `Extracted ${results.length} items from data-items attribute`
      );
      return results;
    }

    // Initialize debug info
    const debugInfo: ExtractionDebugInfo = {
      containerCount: containers.length,
      selectorMatches: {},
      fieldExtractionStats: {},
    };

    // Count selector matches
    // Helper function to count selector matches (handles nested structures)
    const countSelectorMatches = (
      selector: any,
      container: cheerio.Cheerio<any>
    ): number => {
      if (
        typeof selector === "object" &&
        selector !== null &&
        "type" in selector &&
        selector.type === "array" &&
        "containerSelector" in selector
      ) {
        const cleanSelector = stripPseudoElements(selector.containerSelector);
        return container.find(cleanSelector).length;
      } else if (typeof selector === "string") {
        const parsed = parseSelector(selector);
        return container.find(parsed.selector).length;
      }
      return 0;
    };

    Object.entries(extraction.selectors).forEach(
      ([fieldName, fieldSelector]) => {
        try {
          const matches = countSelectorMatches(fieldSelector, containers);
          debugInfo.selectorMatches![fieldName] = matches;
        } catch (error) {
          debugInfo.selectorMatches![fieldName] = 0;
        }

        // Initialize field stats
        debugInfo.fieldExtractionStats![fieldName] = {
          success: 0,
          failed: 0,
          nullCount: 0,
        };
      }
    );

    containers.each((_, element) => {
      const $element = $(element);
      const item: Record<string, any> = {};

      Object.entries(extraction.selectors).forEach(
        ([fieldName, fieldSelector]) => {
          try {
            const value = extractField($element, fieldSelector);
            item[fieldName] = value;

            // Update stats
            const stats = debugInfo.fieldExtractionStats![fieldName];
            if (stats) {
              if (value === null || value === undefined) {
                stats.nullCount++;
                stats.failed++;
              } else {
                stats.success++;
              }
            }
          } catch (error) {
            console.warn(`Error extracting field "${fieldName}":`, error);
            item[fieldName] = null;
            const errorStats = debugInfo.fieldExtractionStats![fieldName];
            if (errorStats) {
              errorStats.failed++;
              errorStats.nullCount++;
            }
          }
        }
      );

      results.push(item);
    });

    debugInfo.itemsExtracted = results.length;

    // Log debug info
    logExtractionDebugInfo(debugInfo);

    console.log(`Extracted ${results.length} items`);
    return results;
  } else {
    // Single object extraction
    const result: Record<string, any> = {};
    Object.entries(extraction.selectors).forEach(
      ([fieldName, fieldSelector]) => {
        // Skip nested extraction configs (they're handled separately)
        if (
          fieldSelector &&
          typeof fieldSelector === "object" &&
          "type" in fieldSelector &&
          fieldSelector.type === "array"
        ) {
          // Nested array extraction - skip for single object extraction
          return;
        }

        const parsed = parseSelector(fieldSelector);
        const selected = $(parsed.selector).first();

        if (parsed.type === "text") {
          result[fieldName] = selected.text().trim();
        } else if (parsed.type === "attr" && parsed.attribute) {
          result[fieldName] = selected.attr(parsed.attribute) || null;
        } else if (parsed.type === "html") {
          result[fieldName] = selected.html() || null;
        } else {
          result[fieldName] = selected.text().trim();
        }
      }
    );

    return result;
  }
}

/**
 * Extract data from response body based on instructions
 */
function extractData(body: string, instructions: ScrapingInstructions): any {
  if (instructions.responseType === "json") {
    return extractFromJSON(body, instructions);
  } else if (
    instructions.responseType === "html" ||
    instructions.responseType === "xml"
  ) {
    return extractFromHTML(body, instructions);
  } else {
    throw new Error(`Unsupported response type: ${instructions.responseType}`);
  }
}

/**
 * Scrape using stored instructions
 */
export async function scrapeWithInstructions(
  id: string,
  paginationOptions: PaginationOptions = {}
): Promise<ScrapeResult> {
  const metadata = await getScrapingInstructions(id);
  if (!metadata) {
    throw new Error(`Scraping instructions not found for ID: ${id}`);
  }

  const { instructions } = metadata;

  console.log(`\n=== SCRAPING WITH INSTRUCTIONS ===`);
  console.log(`ID: ${id}`);
  console.log(`Method: ${instructions.method}`);
  console.log(`Base URL: ${instructions.baseUrl}`);
  console.log(`Response Type: ${instructions.responseType}`);
  console.log(`Output Type: ${instructions.outputType}`);
  if (paginationOptions.page !== undefined) {
    console.log(`Page: ${paginationOptions.page}`);
  }
  if (paginationOptions.offset !== undefined) {
    console.log(`Offset: ${paginationOptions.offset}`);
  }

  try {
    const responseBody = await makeRequest(instructions, paginationOptions);
    const data = extractData(responseBody, instructions);

    const result: ScrapeResult = {
      data,
      pagination: {
        page: paginationOptions.page,
        limit: paginationOptions.limit,
        offset: paginationOptions.offset,
      },
    };

    // Save scrape result to database
    try {
      await saveScrapeResult(id, data, result.pagination);
    } catch (error) {
      console.error("⚠️  Failed to save scrape result to database:", error);
      // Don't throw - we still want to return the result even if saving fails
    }

    console.log(
      `✅ Scraping completed. Extracted ${
        Array.isArray(data) ? data.length : 1
      } item(s)`
    );
    return result;
  } catch (error) {
    console.error("❌ Scraping failed:", error);
    throw error;
  }
}
