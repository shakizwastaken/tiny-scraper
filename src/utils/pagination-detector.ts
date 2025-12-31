import type { InterceptedRequest } from "../types/scraping";

export interface PaginationHints {
  queryParams?: Record<string, string>;
  bodyParams?: Record<string, any>;
  urlPattern?: string;
  hasPaginationControls?: boolean;
  detectedPattern?: "page" | "offset" | "cursor" | "none";
  examples?: string[];
}

/**
 * Analyze URL for pagination patterns
 */
export function detectPaginationFromUrl(url: string): PaginationHints {
  try {
    const urlObj = new URL(url);
    const queryParams: Record<string, string> = {};
    const hints: PaginationHints = { queryParams };

    // Common pagination query param names (exact matches and word boundaries)
    const paginationParams = [
      "page",
      "p",
      "pageNum",
      "pageNumber",
      "offset",
      "skip",
      "start",
      "startIndex",
      "limit",
      "per_page",
      "perPage",
      "size",
      "pageSize",
      "cursor",
      "after",
      "before",
      "next",
      "nextToken",
    ];

    // Create regex patterns for exact/word-boundary matching
    const pagePattern = /\b(page|p|pageNum|pageNumber)\b/i;
    const offsetPattern = /\b(offset|skip|start|startIndex)\b/i;
    const cursorPattern = /\b(cursor|after|before|next|nextToken)\b/i;

    urlObj.searchParams.forEach((value, key) => {
      const keyLower = key.toLowerCase();

      // Use word boundary matching to prevent false positives
      const isPaginationParam = paginationParams.some((p) => {
        const pattern = new RegExp(
          `\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "i"
        );
        return pattern.test(keyLower);
      });

      if (isPaginationParam) {
        queryParams[key] = value;

        // Determine pattern type (prioritize page, then offset, then cursor)
        if (!hints.detectedPattern && pagePattern.test(keyLower)) {
          hints.detectedPattern = "page";
        } else if (!hints.detectedPattern && offsetPattern.test(keyLower)) {
          hints.detectedPattern = "offset";
        } else if (!hints.detectedPattern && cursorPattern.test(keyLower)) {
          hints.detectedPattern = "cursor";
        }
      }
    });

    hints.urlPattern = urlObj.toString();
    hints.examples = Object.keys(queryParams);

    return hints;
  } catch (error) {
    // Invalid URL, return empty hints
    return { detectedPattern: "none" };
  }
}

/**
 * Extract pagination hints from HTML response
 */
export function detectPaginationFromHTML(html: string): PaginationHints {
  const hints: PaginationHints = {};

  // Look for common pagination patterns in HTML (with word boundaries where appropriate)
  const paginationPatterns = [
    /\bpage[=\s]*(\d+)/gi,
    /\bpaging[=\s]*(\d+)/gi,
    /\boffset[=\s]*(\d+)/gi,
    /\bnext[_-]?page\b/gi,
    /\bprev[_-]?page\b/gi,
    /\bpagination\b/gi,
    /data-page[=\s]*["']?(\d+)/gi,
    /class[=\s]*["'][^"']*\bpagination\b[^"']*["']/gi,
    /class[=\s]*["'][^"']*\bpager\b[^"']*["']/gi,
    /<button[^>]*\b(load|more|next|show)\b[^>]*>/gi,
    /<a[^>]*\b(load|more|next|show)\b[^>]*>/gi,
    // Add AJAX pagination patterns
    /data-type[=\s]*["']?ajax["']?/gi,
    /data-items[=\s]*["']/gi,
    /class[=\s]*["'][^"']*\bajax[^"']*["']/gi,
  ];

  let hasControls = false;
  // Reset regex lastIndex to avoid state issues
  for (const pattern of paginationPatterns) {
    pattern.lastIndex = 0; // Reset regex state
    if (pattern.test(html)) {
      hasControls = true;
      break;
    }
  }

  // Check for data-items attribute with JSON data (AJAX pagination indicator)
  const dataItemsPattern = /data-items[=\s]*["']([^"']+)["']/gi;
  let dataItemsMatch;
  const foundDataItems: string[] = [];

  // Helper function to decode HTML entities
  function decodeHtmlEntities(text: string): string {
    return text
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, "/");
  }

  while ((dataItemsMatch = dataItemsPattern.exec(html)) !== null) {
    const dataItemsValue = dataItemsMatch[1];
    if (dataItemsValue) {
      // Decode HTML entities
      const decoded = decodeHtmlEntities(dataItemsValue);

      // Try to parse as JSON to verify it's valid
      try {
        const parsed = JSON.parse(decoded);
        if (Array.isArray(parsed) && parsed.length > 0) {
          foundDataItems.push(decoded);
          hasControls = true; // This indicates pagination-capable content
        }
      } catch (e) {
        // Not valid JSON, but still might indicate AJAX pagination
        if (dataItemsValue.length > 50) {
          hasControls = true;
        }
      }
    }
  }

  hints.hasPaginationControls = hasControls;

  // Extract query params from links (handle both relative and absolute URLs)
  const linkPattern = /href=["']([^"']+)["']/gi;
  const linkParams = new Set<string>();
  let match;
  const baseUrlPattern = /^https?:\/\//i;

  while ((match = linkPattern.exec(html)) !== null) {
    try {
      const matchUrl = match[1];
      if (matchUrl && matchUrl.includes("?")) {
        // Determine base URL for relative links
        let baseUrl = "https://example.com";
        if (baseUrlPattern.test(matchUrl)) {
          // Absolute URL
          const url = new URL(matchUrl);
          url.searchParams.forEach((value, key) => {
            const keyLower = key.toLowerCase();
            const pagePattern = /\b(page|p|pageNum|pageNumber)\b/;
            const offsetPattern = /\b(offset|skip|start|startIndex)\b/;
            const cursorPattern = /\b(cursor|after|before|next|nextToken)\b/;

            if (
              pagePattern.test(keyLower) ||
              offsetPattern.test(keyLower) ||
              cursorPattern.test(keyLower)
            ) {
              linkParams.add(`${key}=${value}`);
            }
          });
        } else {
          // Relative URL - try to extract query params
          const queryMatch = matchUrl.match(/\?([^#]+)/);
          if (queryMatch) {
            const params = new URLSearchParams(queryMatch[1]);
            params.forEach((value, key) => {
              const keyLower = key.toLowerCase();
              const pagePattern = /\b(page|p|pageNum|pageNumber)\b/;
              const offsetPattern = /\b(offset|skip|start|startIndex)\b/;
              const cursorPattern = /\b(cursor|after|before|next|nextToken)\b/;

              if (
                pagePattern.test(keyLower) ||
                offsetPattern.test(keyLower) ||
                cursorPattern.test(keyLower)
              ) {
                linkParams.add(`${key}=${value}`);
              }
            });
          }
        }
      }
    } catch (e) {
      // Invalid URL, skip
    }
  }

  if (linkParams.size > 0) {
    hints.examples = Array.from(linkParams);
  }

  // If we found data-items with JSON, add a note about AJAX pagination
  if (foundDataItems.length > 0) {
    if (!hints.examples) {
      hints.examples = [];
    }
    hints.examples.push(
      `data-items (AJAX pagination detected - ${foundDataItems.length} data attribute(s) found)`
    );
  }

  return hints;
}

/**
 * Extract pagination hints from JSON response
 */
export function detectPaginationFromJSON(json: any): PaginationHints {
  const hints: PaginationHints = {};

  // Common pagination field names in JSON responses
  const paginationFields = [
    "page",
    "currentPage",
    "pageNumber",
    "pageNum",
    "offset",
    "skip",
    "start",
    "limit",
    "perPage",
    "pageSize",
    "size",
    "total",
    "totalCount",
    "totalPages",
    "hasMore",
    "next",
    "nextPage",
    "nextCursor",
    "nextToken",
    "prev",
    "previous",
    "previousPage",
    "previousCursor",
    "pagination",
  ];

  const foundFields: Record<string, any> = {};

  function searchObject(obj: any, path: string = ""): void {
    if (!obj || typeof obj !== "object") return;

    for (const [key, value] of Object.entries(obj)) {
      const keyLower = key.toLowerCase();
      const fullPath = path ? `${path}.${key}` : key;

      // Use word boundary matching for better accuracy
      const isPaginationField = paginationFields.some((field) => {
        const pattern = new RegExp(
          `\\b${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "i"
        );
        return pattern.test(keyLower);
      });

      if (isPaginationField) {
        foundFields[fullPath] = value;

        // Determine pattern type (only set if not already set)
        if (!hints.detectedPattern) {
          if (/\b(page|currentPage|pageNumber|pageNum)\b/.test(keyLower)) {
            hints.detectedPattern = "page";
          } else if (/\b(offset|skip|start|startIndex)\b/.test(keyLower)) {
            hints.detectedPattern = "offset";
          } else if (
            /\b(cursor|nextCursor|nextToken|after|before)\b/.test(keyLower)
          ) {
            hints.detectedPattern = "cursor";
          }
        }
      }

      // Handle arrays - search each element if it's an object
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i];
          if (item && typeof item === "object" && !Array.isArray(item)) {
            searchObject(item, `${fullPath}[${i}]`);
          }
        }
      } else if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        searchObject(value, fullPath);
      }
    }
  }

  searchObject(json);

  if (Object.keys(foundFields).length > 0) {
    hints.bodyParams = foundFields;
    hints.examples = Object.keys(foundFields).slice(0, 5);
  }

  return hints;
}

/**
 * Extract pagination context from HTML (beginning/end sections)
 */
export function extractPaginationContext(responseBody: string): string {
  const paginationKeywords = [
    "pagination",
    "page",
    "next",
    "previous",
    "prev",
    "offset",
    "limit",
  ];
  const paginationSections: string[] = [];

  // Look at beginning (headers/query params might be here for JSON)
  const first5k = responseBody.substring(0, 5000);
  if (paginationKeywords.some((kw) => first5k.toLowerCase().includes(kw))) {
    paginationSections.push(first5k);
  }

  // Look at end (pagination controls often at bottom of HTML)
  const last5k = responseBody.substring(
    Math.max(0, responseBody.length - 5000)
  );
  if (paginationKeywords.some((kw) => last5k.toLowerCase().includes(kw))) {
    paginationSections.push(last5k);
  }

  // Look for specific pagination patterns in HTML
  const pageLinkPattern =
    /<[^>]*(?:page|pagination|pager)[^>]*>[\s\S]{0,500}/gi;
  let match;
  while (
    (match = pageLinkPattern.exec(responseBody)) !== null &&
    paginationSections.length < 3
  ) {
    paginationSections.push(match[0]);
  }

  return paginationSections.join("\n\n---\n\n");
}

/**
 * Extract pagination hints from HTTP headers
 */
export function detectPaginationFromHeaders(
  headers: Record<string, string>
): PaginationHints {
  const hints: PaginationHints = {};
  const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());

  // Check Link header (RFC 5988)
  const linkHeader = headers["Link"] || headers["link"];
  if (linkHeader) {
    // Parse Link header: <url>; rel="next", <url>; rel="prev"
    const linkPattern = /<([^>]+)>;\s*rel=["']?([^"',\s]+)["']?/gi;
    let match;
    const linkParams: string[] = [];

    while ((match = linkPattern.exec(linkHeader)) !== null) {
      const url = match[1];
      const rel = match[2]?.toLowerCase();

      if (
        rel === "next" ||
        rel === "prev" ||
        rel === "first" ||
        rel === "last"
      ) {
        if (!url) continue;
        try {
          const urlObj = new URL(url);
          urlObj.searchParams.forEach((value, key) => {
            const keyLower = key.toLowerCase();
            if (
              /\b(page|p|pageNum|pageNumber|offset|skip|start|cursor|after|before|next|nextToken)\b/.test(
                keyLower
              )
            ) {
              linkParams.push(`${key}=${value}`);
            }
          });
        } catch (e) {
          // Invalid URL, skip
        }
      }
    }

    if (linkParams.length > 0) {
      hints.examples = linkParams;
      hints.hasPaginationControls = true;
    }
  }

  // Check custom pagination headers
  const paginationHeaderPatterns = [
    { pattern: /^x-?(page|pagination|pager)/i, examples: [] as string[] },
    { pattern: /^x-?(total|count|pages)/i, examples: [] as string[] },
    { pattern: /^x-?(next|prev|previous)/i, examples: [] as string[] },
  ];

  for (const headerKey of headerKeys) {
    for (const { pattern, examples } of paginationHeaderPatterns) {
      if (pattern.test(headerKey)) {
        const value = headers[headerKey];
        if (value) {
          examples.push(`${headerKey}: ${value}`);

          if (/\b(page|currentPage|pageNumber)\b/i.test(headerKey)) {
            hints.detectedPattern = "page";
          } else if (/\b(offset|skip|start)\b/i.test(headerKey)) {
            hints.detectedPattern = "offset";
          } else if (/\b(cursor|next|after)\b/i.test(headerKey)) {
            hints.detectedPattern = "cursor";
          }
        }
      }
    }
  }

  return hints;
}

/**
 * Extract pagination hints from POST request body
 */
export function detectPaginationFromBody(body: any): PaginationHints {
  const hints: PaginationHints = {};

  if (!body || typeof body !== "object") {
    return hints;
  }

  // If body is a string, try to parse it
  let parsedBody = body;
  if (typeof body === "string") {
    try {
      parsedBody = JSON.parse(body);
    } catch (e) {
      // Not JSON, return empty hints
      return hints;
    }
  }

  const foundParams: Record<string, any> = {};
  const paginationFields = [
    "page",
    "currentPage",
    "pageNumber",
    "pageNum",
    "offset",
    "skip",
    "start",
    "startIndex",
    "limit",
    "perPage",
    "pageSize",
    "size",
    "cursor",
    "after",
    "before",
    "next",
    "nextToken",
  ];

  function searchBody(obj: any, path: string = ""): void {
    if (!obj || typeof obj !== "object") return;

    for (const [key, value] of Object.entries(obj)) {
      const keyLower = key.toLowerCase();
      const fullPath = path ? `${path}.${key}` : key;

      const isPaginationField = paginationFields.some((field) => {
        const pattern = new RegExp(
          `\\b${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "i"
        );
        return pattern.test(keyLower);
      });

      if (isPaginationField) {
        foundParams[fullPath] = value;

        if (!hints.detectedPattern) {
          if (/\b(page|currentPage|pageNumber|pageNum)\b/.test(keyLower)) {
            hints.detectedPattern = "page";
          } else if (/\b(offset|skip|start|startIndex)\b/.test(keyLower)) {
            hints.detectedPattern = "offset";
          } else if (
            /\b(cursor|nextCursor|nextToken|after|before)\b/.test(keyLower)
          ) {
            hints.detectedPattern = "cursor";
          }
        }
      }

      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i];
          if (item && typeof item === "object" && !Array.isArray(item)) {
            searchBody(item, `${fullPath}[${i}]`);
          }
        }
      } else if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        searchBody(value, fullPath);
      }
    }
  }

  searchBody(parsedBody);

  if (Object.keys(foundParams).length > 0) {
    hints.bodyParams = foundParams;
    hints.examples = Object.keys(foundParams).slice(0, 5);
  }

  return hints;
}

/**
 * Extract pagination hints from response metadata (headers + body structure)
 */
export function detectPaginationFromResponseMetadata(
  headers: Record<string, string>,
  responseBody: string,
  responseType: "json" | "html"
): PaginationHints {
  const hints: PaginationHints = {};

  // Check headers first
  const headerHints = detectPaginationFromHeaders(headers);
  if (headerHints.detectedPattern) {
    hints.detectedPattern = headerHints.detectedPattern;
  }
  if (headerHints.examples && headerHints.examples.length > 0) {
    hints.examples = headerHints.examples;
  }

  // Check response body structure
  if (responseType === "json") {
    try {
      const json = JSON.parse(responseBody);
      const jsonHints = detectPaginationFromJSON(json);
      if (jsonHints.detectedPattern && !hints.detectedPattern) {
        hints.detectedPattern = jsonHints.detectedPattern;
      }
      if (jsonHints.bodyParams) {
        hints.bodyParams = jsonHints.bodyParams;
      }
      if (jsonHints.examples && jsonHints.examples.length > 0) {
        hints.examples = [...(hints.examples || []), ...jsonHints.examples];
      }
    } catch (e) {
      // Not valid JSON, skip
    }
  }

  return hints;
}
