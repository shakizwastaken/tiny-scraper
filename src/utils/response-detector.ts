/**
 * Detect response type from content-type header and body structure
 */
export function detectResponseType(
  contentType: string | undefined,
  responseBody: string
): "json" | "html" | "xml" {
  // Check content-type header first
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes("application/json") || ct.includes("text/json")) {
      return "json";
    }
    if (ct.includes("text/html") || ct.includes("application/xhtml")) {
      return "html";
    }
    if (ct.includes("application/xml") || ct.includes("text/xml")) {
      return "xml";
    }
  }

  // Try to detect from body structure
  const trimmed = responseBody.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    // Try to parse as JSON
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not valid JSON, continue checking
    }
  }

  if (trimmed.startsWith("<")) {
    // Check if it's HTML or XML
    if (
      trimmed.includes("<!DOCTYPE") ||
      trimmed.includes("<html") ||
      trimmed.includes("<body")
    ) {
      return "html";
    }
    return "xml";
  }

  // Default to HTML if we can't determine
  return "html";
}

