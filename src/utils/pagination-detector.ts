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

    // Common pagination query param names
    const paginationParams = [
      "page",
      "p",
      "pageNum",
      "pageNumber",
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

    urlObj.searchParams.forEach((value, key) => {
      const keyLower = key.toLowerCase();
      if (paginationParams.some((p) => keyLower.includes(p.toLowerCase()))) {
        queryParams[key] = value;

        if (keyLower.includes("page")) {
          hints.detectedPattern = "page";
        } else if (
          keyLower.includes("offset") ||
          keyLower.includes("skip") ||
          keyLower.includes("start")
        ) {
          hints.detectedPattern = "offset";
        } else if (
          keyLower.includes("cursor") ||
          keyLower.includes("after") ||
          keyLower.includes("next")
        ) {
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

  // Look for common pagination patterns in HTML
  const paginationPatterns = [
    /page[=\s]*(\d+)/gi,
    /paging[=\s]*(\d+)/gi,
    /offset[=\s]*(\d+)/gi,
    /next[_-]?page/gi,
    /prev[_-]?page/gi,
    /pagination/gi,
    /data-page[=\s]*["']?(\d+)/gi,
    /class[=\s]*["'][^"']*pagination[^"']*["']/gi,
    /class[=\s]*["'][^"']*pager[^"']*["']/gi,
  ];

  let hasControls = false;
  for (const pattern of paginationPatterns) {
    if (pattern.test(html)) {
      hasControls = true;
      break;
    }
  }

  hints.hasPaginationControls = hasControls;

  // Extract query params from links
  const linkPattern = /href=["']([^"']+\?[^"']+)["']/gi;
  const linkParams = new Set<string>();
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    try {
      const matchUrl = match[1];
      if (matchUrl) {
        const url = new URL(matchUrl, "https://example.com");
        url.searchParams.forEach((value, key) => {
          if (
            key.toLowerCase().includes("page") ||
            key.toLowerCase().includes("offset") ||
            key.toLowerCase().includes("cursor")
          ) {
            linkParams.add(`${key}=${value}`);
          }
        });
      }
    } catch (e) {
      // Invalid URL, skip
    }
  }

  if (linkParams.size > 0) {
    hints.examples = Array.from(linkParams);
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

      if (
        paginationFields.some((field) => keyLower.includes(field.toLowerCase()))
      ) {
        foundFields[fullPath] = value;

        if (keyLower.includes("page")) {
          hints.detectedPattern = "page";
        } else if (keyLower.includes("offset") || keyLower.includes("skip")) {
          hints.detectedPattern = "offset";
        } else if (keyLower.includes("cursor") || keyLower.includes("next")) {
          hints.detectedPattern = "cursor";
        }
      }

      if (
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
