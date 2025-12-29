/**
 * Validate scrape request query parameters
 */
export function validateScrapeRequest(
  url: unknown,
  search: unknown
): { url: string; search: string } {
  if (!url || typeof url !== "string") {
    throw new Error("Missing or invalid 'url' query parameter");
  }

  if (!search || typeof search !== "string") {
    throw new Error("Missing or invalid 'search' query parameter");
  }

  return { url, search };
}

