/**
 * Validate scrape request query parameters
 */
export function validateScrapeRequest(
  url: unknown,
  search: unknown,
  expectedOutputType?: unknown,
  customPrompt?: unknown
): {
  url: string;
  search: string;
  expectedOutputType?: "array" | "object";
  customPrompt?: string;
} {
  if (!url || typeof url !== "string") {
    throw new Error("Missing or invalid 'url' query parameter");
  }

  if (!search || typeof search !== "string") {
    throw new Error("Missing or invalid 'search' query parameter");
  }

  let validatedExpectedOutputType: "array" | "object" | undefined;
  if (expectedOutputType !== undefined && expectedOutputType !== null) {
    if (typeof expectedOutputType !== "string") {
      throw new Error(
        "Invalid 'expectedOutputType' query parameter. Must be a string."
      );
    }
    if (expectedOutputType !== "array" && expectedOutputType !== "object") {
      throw new Error(
        "Invalid 'expectedOutputType' query parameter. Must be 'array' or 'object'."
      );
    }
    validatedExpectedOutputType = expectedOutputType as "array" | "object";
  }

  let validatedCustomPrompt: string | undefined;
  if (customPrompt !== undefined && customPrompt !== null) {
    if (typeof customPrompt !== "string") {
      throw new Error(
        "Invalid 'customPrompt' query parameter. Must be a string."
      );
    }
    validatedCustomPrompt = customPrompt;
  }

  return {
    url,
    search,
    expectedOutputType: validatedExpectedOutputType,
    customPrompt: validatedCustomPrompt,
  };
}
