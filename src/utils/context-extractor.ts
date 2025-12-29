/**
 * Extract context around the search term, centering it in the available context window
 */
export function extractContextAroundSearchTerm(
  responseBody: string,
  searchTerm: string,
  maxTokens: number = 1000000
): string {
  const searchLower = searchTerm.toLowerCase();
  const bodyLower = responseBody.toLowerCase();
  const searchIndex = bodyLower.indexOf(searchLower);

  if (searchIndex === -1) {
    // Search term not found, return entire body (truncated if needed)
    const maxChars = maxTokens * 4; // ~4 chars per token
    return responseBody.length > maxChars
      ? responseBody.substring(0, maxChars)
      : responseBody;
  }

  // Calculate available characters (conservative: 4 chars per token)
  const maxChars = maxTokens * 4;
  const halfContext = Math.floor(maxChars / 2);

  // Find the start position (before search term)
  const startBefore = Math.max(0, searchIndex - halfContext);
  // Find the end position (after search term)
  const endAfter = Math.min(
    responseBody.length,
    searchIndex + searchTerm.length + halfContext
  );

  // Extract context
  const context = responseBody.substring(startBefore, endAfter);

  console.log(
    `   📍 Context extraction: Search term at position ${searchIndex}, extracted ${context.length} chars (${startBefore} to ${endAfter})`
  );

  return context;
}

