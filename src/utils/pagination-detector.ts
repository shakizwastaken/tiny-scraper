import type { InterceptedRequest } from "../types/scraping";

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
  // Additional detection hints
  infiniteScroll?: boolean;
  graphQLCursor?: boolean;
  timeBased?: boolean;
  tokenBased?: boolean;
  hybridPagination?: boolean;
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
      // GraphQL pagination
      "first",
      "last",
      "after",
      "before",
      // Time-based pagination
      "since",
      "until",
      "from",
      "to",
      "startTime",
      "endTime",
      "timestamp",
      "createdAfter",
      "createdBefore",
      // Token-based pagination
      "token",
      "accessToken",
      "pageToken",
      "continuationToken",
      // Hybrid pagination
      "pageSize",
      "pageToken",
    ];

    // Create regex patterns for exact/word-boundary matching
    const pagePattern = /\b(page|p|pageNum|pageNumber)\b/i;
    const offsetPattern = /\b(offset|skip|start|startIndex)\b/i;
    const cursorPattern = /\b(cursor|after|before|next|nextToken)\b/i;
    const graphQLPattern = /\b(first|last|after|before)\b/i;
    const timePattern =
      /\b(since|until|from|to|startTime|endTime|timestamp|createdAfter|createdBefore)\b/i;
    const tokenPattern = /\b(token|accessToken|pageToken|continuationToken)\b/i;

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

        // Determine pattern type (prioritize page, then offset, then cursor, then others)
        if (!hints.detectedPattern && pagePattern.test(keyLower)) {
          hints.detectedPattern = "page";
        } else if (!hints.detectedPattern && offsetPattern.test(keyLower)) {
          hints.detectedPattern = "offset";
        } else if (!hints.detectedPattern && graphQLPattern.test(keyLower)) {
          hints.detectedPattern = "graphql";
          hints.graphQLCursor = true;
        } else if (!hints.detectedPattern && timePattern.test(keyLower)) {
          hints.detectedPattern = "time";
          hints.timeBased = true;
        } else if (!hints.detectedPattern && tokenPattern.test(keyLower)) {
          hints.detectedPattern = "token";
          hints.tokenBased = true;
        } else if (!hints.detectedPattern && cursorPattern.test(keyLower)) {
          hints.detectedPattern = "cursor";
        }

        // Check for hybrid pagination (e.g., page + pageSize, page + cursor)
        if (
          hints.detectedPattern &&
          (keyLower.includes("page") ||
            keyLower.includes("cursor") ||
            keyLower.includes("token"))
        ) {
          const hasPage =
            queryParams.hasOwnProperty("page") ||
            queryParams.hasOwnProperty("p");
          const hasCursor =
            queryParams.hasOwnProperty("cursor") ||
            queryParams.hasOwnProperty("after");
          const hasToken =
            queryParams.hasOwnProperty("token") ||
            queryParams.hasOwnProperty("pageToken");
          const hasSize =
            queryParams.hasOwnProperty("pageSize") ||
            queryParams.hasOwnProperty("size");

          if (
            (hasPage && hasCursor) ||
            (hasPage && hasToken) ||
            (hasCursor && hasSize)
          ) {
            hints.detectedPattern = "hybrid";
            hints.hybridPagination = true;
          }
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
    // Infinite scroll patterns
    /intersection[_-]?observer/gi,
    /scroll[_-]?pagination/gi,
    /infinite[_-]?scroll/gi,
    /lazy[_-]?load/gi,
    /on[_-]?scroll[=:]/gi,
    /addEventListener\s*\(\s*["']scroll["']/gi,
    // GraphQL patterns
    /graphql/gi,
    /query\s*\{[^}]*first[^}]*after/gi,
    // Time-based patterns
    /timestamp[=\s]*["']?(\d+)/gi,
    /created[_-]?after/gi,
    /created[_-]?before/gi,
    /since[=\s]*["']?(\d+)/gi,
    /until[=\s]*["']?(\d+)/gi,
  ];

  let hasControls = false;
  let hasInfiniteScroll = false;
  let hasGraphQL = false;
  let hasTimeBased = false;

  // Reset regex lastIndex to avoid state issues
  for (const pattern of paginationPatterns) {
    pattern.lastIndex = 0; // Reset regex state
    if (pattern.test(html)) {
      hasControls = true;

      // Check for specific patterns
      if (
        pattern.source.includes("scroll") ||
        pattern.source.includes("intersection") ||
        pattern.source.includes("lazy")
      ) {
        hasInfiniteScroll = true;
      }
      if (
        pattern.source.includes("graphql") ||
        pattern.source.includes("first") ||
        pattern.source.includes("after")
      ) {
        hasGraphQL = true;
      }
      if (
        pattern.source.includes("timestamp") ||
        pattern.source.includes("since") ||
        pattern.source.includes("until") ||
        pattern.source.includes("created")
      ) {
        hasTimeBased = true;
      }
    }
  }

  hints.infiniteScroll = hasInfiniteScroll;
  hints.graphQLCursor = hasGraphQL;
  hints.timeBased = hasTimeBased;

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
 * Detect pagination from JavaScript code (bundles, inline scripts)
 */
export function detectPaginationFromJavaScript(code: string): PaginationHints {
  const hints: PaginationHints = {};

  // Patterns for infinite scroll
  const infiniteScrollPatterns = [
    /intersection[_-]?observer/gi,
    /addEventListener\s*\(\s*["']scroll["']/gi,
    /on[_-]?scroll[=:]/gi,
    /scroll[_-]?pagination/gi,
    /infinite[_-]?scroll/gi,
    /lazy[_-]?load/gi,
  ];

  // Patterns for pagination API calls
  const paginationAPIPatterns = [
    /fetch\s*\([^)]*page[=:]/gi,
    /axios\s*\.\s*(get|post)\s*\([^)]*page[=:]/gi,
    /\.get\s*\([^)]*page[=:]/gi,
    /\.post\s*\([^)]*page[=:]/gi,
    /pagination[=:]/gi,
    /page[=:]\s*\d+/gi,
  ];

  // Patterns for GraphQL pagination
  const graphQLPatterns = [
    /query\s*\{[^}]*first[^}]*after/gi,
    /edges\s*\{[^}]*node/gi,
    /pageInfo\s*\{[^}]*hasNextPage/gi,
  ];

  let hasInfiniteScroll = false;
  let hasGraphQL = false;
  let hasPaginationAPI = false;

  for (const pattern of infiniteScrollPatterns) {
    if (pattern.test(code)) {
      hasInfiniteScroll = true;
      hints.infiniteScroll = true;
      hints.detectedPattern = "scroll";
      break;
    }
  }

  for (const pattern of graphQLPatterns) {
    if (pattern.test(code)) {
      hasGraphQL = true;
      hints.graphQLCursor = true;
      if (!hints.detectedPattern) {
        hints.detectedPattern = "graphql";
      }
      break;
    }
  }

  for (const pattern of paginationAPIPatterns) {
    if (pattern.test(code)) {
      hasPaginationAPI = true;
      if (!hints.detectedPattern) {
        hints.detectedPattern = "page";
      }
      break;
    }
  }

  if (hasInfiniteScroll || hasGraphQL || hasPaginationAPI) {
    hints.hasPaginationControls = true;
  }

  return hints;
}

/**
 * Detect pagination from RFC 5988 Link headers
 */
export function detectPaginationFromLinkHeader(
  linkHeader: string
): PaginationHints {
  const hints: PaginationHints = {};

  // Parse Link header: <url>; rel="next", <url>; rel="prev"
  const linkPattern = /<([^>]+)>;\s*rel=["']?([^"',\s]+)["']?/gi;
  const links: Array<{ url: string; rel: string }> = [];
  let match;

  while ((match = linkPattern.exec(linkHeader)) !== null) {
    const url = match[1];
    const rel = match[2]?.toLowerCase();

    if (
      url &&
      rel &&
      (rel === "next" || rel === "prev" || rel === "first" || rel === "last")
    ) {
      links.push({ url, rel });

      // Extract pagination params from URL
      try {
        const urlObj = new URL(url);
        urlObj.searchParams.forEach((value, key) => {
          const keyLower = key.toLowerCase();
          if (
            /\b(page|p|pageNum|pageNumber|offset|skip|start|cursor|after|before|next|nextToken)\b/.test(
              keyLower
            )
          ) {
            if (!hints.queryParams) {
              hints.queryParams = {};
            }
            hints.queryParams[key] = value;

            // Determine pattern type
            if (!hints.detectedPattern) {
              if (/\b(page|p|pageNum|pageNumber)\b/.test(keyLower)) {
                hints.detectedPattern = "page";
              } else if (/\b(offset|skip|start)\b/.test(keyLower)) {
                hints.detectedPattern = "offset";
              } else if (
                /\b(cursor|after|before|next|nextToken)\b/.test(keyLower)
              ) {
                hints.detectedPattern = "cursor";
              }
            }
          }
        });
      } catch (e) {
        // Invalid URL, skip
      }
    }
  }

  if (links.length > 0) {
    hints.hasPaginationControls = true;
    hints.examples = links.map((l) => `${l.rel}: ${l.url}`);
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
    // GraphQL pagination
    "first",
    "last",
    "after",
    "before",
    "edges",
    "pageInfo",
    // Time-based pagination
    "since",
    "until",
    "from",
    "to",
    "startTime",
    "endTime",
    "timestamp",
    "createdAfter",
    "createdBefore",
    // Token-based pagination
    "token",
    "accessToken",
    "pageToken",
    "continuationToken",
    // Hybrid pagination
    "pageSize",
    "pageToken",
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
          } else if (/\b(first|last|edges|pageInfo)\b/.test(keyLower)) {
            hints.detectedPattern = "graphql";
            hints.graphQLCursor = true;
          } else if (
            /\b(since|until|timestamp|createdAfter|createdBefore|startTime|endTime)\b/.test(
              keyLower
            )
          ) {
            hints.detectedPattern = "time";
            hints.timeBased = true;
          } else if (
            /\b(token|pageToken|continuationToken|accessToken)\b/.test(keyLower)
          ) {
            hints.detectedPattern = "token";
            hints.tokenBased = true;
          } else if (
            /\b(cursor|nextCursor|nextToken|after|before)\b/.test(keyLower)
          ) {
            hints.detectedPattern = "cursor";
          }
        }

        // Check for hybrid pagination
        if (
          hints.detectedPattern &&
          (keyLower.includes("page") ||
            keyLower.includes("cursor") ||
            keyLower.includes("token"))
        ) {
          const hasPage =
            foundFields.hasOwnProperty("page") ||
            foundFields.hasOwnProperty("currentPage");
          const hasCursor =
            foundFields.hasOwnProperty("cursor") ||
            foundFields.hasOwnProperty("after");
          const hasToken =
            foundFields.hasOwnProperty("token") ||
            foundFields.hasOwnProperty("pageToken");
          const hasSize =
            foundFields.hasOwnProperty("pageSize") ||
            foundFields.hasOwnProperty("size");

          if (
            (hasPage && hasCursor) ||
            (hasPage && hasToken) ||
            (hasCursor && hasSize)
          ) {
            hints.detectedPattern = "hybrid";
            hints.hybridPagination = true;
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
    const linkHints = detectPaginationFromLinkHeader(linkHeader);
    if (linkHints.detectedPattern) {
      hints.detectedPattern = linkHints.detectedPattern;
    }
    if (linkHints.examples && linkHints.examples.length > 0) {
      hints.examples = linkHints.examples;
    }
    if (linkHints.hasPaginationControls) {
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
    // GraphQL pagination
    "first",
    "last",
    "after",
    "before",
    // Time-based pagination
    "since",
    "until",
    "from",
    "to",
    "startTime",
    "endTime",
    "timestamp",
    "createdAfter",
    "createdBefore",
    // Token-based pagination
    "token",
    "accessToken",
    "pageToken",
    "continuationToken",
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
          } else if (/\b(first|last|edges|pageInfo)\b/.test(keyLower)) {
            hints.detectedPattern = "graphql";
            hints.graphQLCursor = true;
          } else if (
            /\b(since|until|timestamp|createdAfter|createdBefore|startTime|endTime)\b/.test(
              keyLower
            )
          ) {
            hints.detectedPattern = "time";
            hints.timeBased = true;
          } else if (
            /\b(token|pageToken|continuationToken|accessToken)\b/.test(keyLower)
          ) {
            hints.detectedPattern = "token";
            hints.tokenBased = true;
          } else if (
            /\b(cursor|nextCursor|nextToken|after|before)\b/.test(keyLower)
          ) {
            hints.detectedPattern = "cursor";
          }
        }

        // Check for hybrid pagination
        if (
          hints.detectedPattern &&
          (keyLower.includes("page") ||
            keyLower.includes("cursor") ||
            keyLower.includes("token"))
        ) {
          const hasPage =
            foundParams.hasOwnProperty("page") ||
            foundParams.hasOwnProperty("currentPage");
          const hasCursor =
            foundParams.hasOwnProperty("cursor") ||
            foundParams.hasOwnProperty("after");
          const hasToken =
            foundParams.hasOwnProperty("token") ||
            foundParams.hasOwnProperty("pageToken");
          const hasSize =
            foundParams.hasOwnProperty("pageSize") ||
            foundParams.hasOwnProperty("size");

          if (
            (hasPage && hasCursor) ||
            (hasPage && hasToken) ||
            (hasCursor && hasSize)
          ) {
            hints.detectedPattern = "hybrid";
            hints.hybridPagination = true;
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
