/**
 * Detect response type from content-type header and body structure
 * Enhanced to handle more variants and edge cases
 */
export function detectResponseType(
  contentType: string | undefined,
  responseBody: string
): "json" | "html" | "xml" {
  // Check content-type header first
  if (contentType) {
    const ct = contentType.toLowerCase();

    // JSON variants
    if (
      ct.includes("application/json") ||
      ct.includes("text/json") ||
      ct.includes("application/json+ld") ||
      ct.includes("application/vnd.api+json") ||
      ct.includes("application/hal+json")
    ) {
      return "json";
    }

    // HTML variants
    if (
      ct.includes("text/html") ||
      ct.includes("application/xhtml") ||
      ct.includes("application/xhtml+xml")
    ) {
      return "html";
    }

    // XML variants
    if (
      ct.includes("application/xml") ||
      ct.includes("text/xml") ||
      ct.includes("application/rss+xml") ||
      ct.includes("application/atom+xml") ||
      ct.includes("application/soap+xml") ||
      ct.includes("application/rdf+xml")
    ) {
      return "xml";
    }

    // Check for binary formats (should not be scraped)
    if (
      ct.includes("image/") ||
      ct.includes("video/") ||
      ct.includes("audio/") ||
      ct.includes("application/pdf") ||
      ct.includes("application/octet-stream")
    ) {
      // Default to HTML for binary, but log warning
      console.warn(
        `Binary content type detected: ${contentType}, defaulting to HTML`
      );
      return "html";
    }
  }

  // Try to detect from body structure
  const trimmed = responseBody.trim();

  // Check for empty or very short responses
  if (trimmed.length === 0) {
    return "html"; // Default
  }

  // JSON detection (more robust)
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not valid JSON, might be JSON5 or malformed
      // Try to detect JSON-like structure
      if (trimmed.match(/^[\s]*[{\[]/)) {
        // Looks like JSON but failed to parse - might be JSON5 or partial
        // Check for common JSON patterns
        if (
          trimmed.includes('"') ||
          trimmed.includes("'") ||
          trimmed.match(/\d+/)
        ) {
          return "json"; // Assume JSON even if malformed
        }
      }
    }
  }

  // XML/HTML detection
  if (trimmed.startsWith("<")) {
    // Check if it's HTML
    if (
      trimmed.includes("<!DOCTYPE") ||
      trimmed.includes("<!doctype") ||
      trimmed.includes("<html") ||
      trimmed.includes("<HTML") ||
      trimmed.includes("<body") ||
      trimmed.includes("<BODY") ||
      trimmed.includes("<head") ||
      trimmed.includes("<HEAD") ||
      trimmed.match(/<html[\s>]/i) ||
      trimmed.match(/<body[\s>]/i)
    ) {
      return "html";
    }

    // Check for XML patterns
    if (
      trimmed.includes("<?xml") ||
      trimmed.match(/<[a-zA-Z]+:[\w]+/) || // Namespace pattern
      trimmed.match(/<rss/i) ||
      trimmed.match(/<feed/i) ||
      trimmed.match(/<atom/i)
    ) {
      return "xml";
    }

    // Default to HTML for other < tags
    return "html";
  }

  // Check for JSON-like content without braces (rare but possible)
  if (trimmed.match(/^\s*[\w]+:\s*["\[]/)) {
    try {
      JSON.parse(`{${trimmed}}`);
      return "json";
    } catch {
      // Not JSON
    }
  }

  // Default to HTML if we can't determine
  return "html";
}
