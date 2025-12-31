import OpenAI from "openai";
import type { HTTPResponse } from "puppeteer";
import type {
  InterceptedRequest,
  RequestSelectionResult,
} from "../types/scraping";
import { openai, OPENAI_REFINEMENT_MODEL } from "../config";

/**
 * Truncate text to approximate token limit (roughly 4 chars per token)
 */
function truncateForTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) {
    return text;
  }
  return text.substring(0, maxChars) + "... (truncated)";
}

/**
 * Case-insensitive content-type matching
 */
function isValidContentType(
  contentType: string,
  expectedType: string
): boolean {
  const normalized = contentType.toLowerCase();
  const expected = expectedType.toLowerCase();
  return normalized.includes(expected);
}

/**
 * Improved JSON extraction from LLM responses
 * Handles multiple code blocks, extracts first JSON object found
 */
function extractJSONFromText(text: string): string | null {
  if (!text || text.trim().length === 0) {
    return null;
  }

  // Try to find JSON in markdown code blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch && codeBlockMatch[1]) {
    return codeBlockMatch[1].trim();
  }

  // Try to find JSON object directly (look for first { ... })
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch && jsonMatch[0]) {
    return jsonMatch[0].trim();
  }

  return null;
}

/**
 * Validate and normalize LLM response structure
 */
function validateRequestSelectionResult(
  result: any,
  maxIndex: number
): RequestSelectionResult {
  // Validate selectedIndex
  if (
    typeof result.selectedIndex !== "number" ||
    isNaN(result.selectedIndex) ||
    !Number.isInteger(result.selectedIndex) ||
    result.selectedIndex < 0 ||
    result.selectedIndex >= maxIndex
  ) {
    console.warn(
      `⚠️  Invalid selectedIndex ${result.selectedIndex}, defaulting to 0`
    );
    result.selectedIndex = 0;
  } else {
    result.selectedIndex = Math.floor(result.selectedIndex);
  }

  // Validate reasoning
  if (!result.reasoning || typeof result.reasoning !== "string") {
    result.reasoning = "Selection made based on request analysis";
  }

  // Validate scores structure if present (optional field)
  if (result.scores && typeof result.scores === "object") {
    // Scores are optional, but if present should be valid
    // We don't need to validate deeply, just ensure it's an object
  }

  return result as RequestSelectionResult;
}

/**
 * Get content type from response headers (case-insensitive)
 */
function getContentType(response?: HTTPResponse): string {
  if (!response) {
    return "unknown";
  }

  try {
    const headers = response.headers();
    // Try common header name variations (case-insensitive)
    const contentType =
      headers["content-type"] ||
      headers["Content-Type"] ||
      headers["CONTENT-TYPE"];

    if (contentType) {
      return contentType;
    }

    // Find case-insensitive match
    const found = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === "content-type"
    );
    if (found && found[1]) {
      return found[1];
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Get status code from response (with error handling)
 */
function getStatusCode(response?: HTTPResponse): number {
  if (!response) {
    return 0;
  }

  try {
    const status = response.status();
    return typeof status === "number" && !isNaN(status) ? status : 0;
  } catch {
    return 0;
  }
}

/**
 * Detect if content type is JSON (handles variants)
 */
function isJSONContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("json") ||
    normalized.includes("application/vnd.api+json") ||
    normalized.startsWith("application/json")
  );
}

/**
 * Detect if content type is HTML/XML (handles variants)
 */
function isHTMLContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("html") ||
    normalized.includes("xml") ||
    normalized.includes("text/html") ||
    normalized.includes("application/xhtml")
  );
}

/**
 * Generate preview of response body with safe JSON parsing
 */
function generatePreview(responseBody: string, isJSON: boolean): string {
  if (!responseBody || responseBody.trim().length === 0) {
    return "(empty response)";
  }

  const maxPreviewLength = 500;

  if (!isJSON) {
    return responseBody.substring(0, maxPreviewLength);
  }

  // Try to parse and stringify JSON for better formatting
  try {
    const parsed = JSON.parse(responseBody);

    // Handle circular references by using a simple stringify
    // Limit depth by truncating very large objects
    let jsonString: string;
    try {
      jsonString = JSON.stringify(parsed);
    } catch (stringifyError) {
      // If stringify fails (circular ref), use original
      return responseBody.substring(0, maxPreviewLength);
    }

    // If the stringified JSON is too large, truncate it
    if (jsonString.length > maxPreviewLength * 2) {
      // For very large JSON, we might want to limit depth
      // For now, just truncate the string
      jsonString = jsonString.substring(0, maxPreviewLength);
    }

    return jsonString.substring(0, maxPreviewLength);
  } catch (parseError) {
    // Not valid JSON, return raw preview
    return responseBody.substring(0, maxPreviewLength);
  }
}

/**
 * Call OpenAI API with retry logic and timeout
 */
async function callOpenAIWithRetry(
  messages: Array<{ role: "system" | "user"; content: string }>,
  maxRetries: number = 2,
  timeoutMs: number = 30000
): Promise<string> {
  if (!openai) {
    throw new Error("OpenAI client not initialized");
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Create a timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("OpenAI API call timeout")),
          timeoutMs
        );
      });

      // Race between API call and timeout
      const completionPromise = openai.chat.completions.create({
        model: OPENAI_REFINEMENT_MODEL,
        messages,
        max_tokens: 2000,
        temperature: 0.3,
      });

      const completion = await Promise.race([
        completionPromise,
        timeoutPromise,
      ]);

      const responseText =
        completion.choices[0]?.message?.content?.trim() || "";
      if (responseText) {
        return responseText;
      }

      throw new Error("Empty response from OpenAI API");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on certain errors (e.g., invalid API key, invalid request)
      if (
        error instanceof Error &&
        (error.message.includes("API key") ||
          error.message.includes("invalid") ||
          error.message.includes("401") ||
          error.message.includes("400"))
      ) {
        throw error;
      }

      // If this was the last attempt, throw the error
      if (attempt === maxRetries) {
        throw lastError;
      }

      // Exponential backoff: wait 1s, 2s, 4s...
      const delayMs = Math.pow(2, attempt) * 1000;
      console.warn(
        `⚠️  OpenAI API call failed (attempt ${attempt + 1}/${
          maxRetries + 1
        }), retrying in ${delayMs}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error("OpenAI API call failed after retries");
}

/**
 * Select the best request from multiple matches using LLM analysis
 */
export async function selectBestRequest(
  matches: InterceptedRequest[],
  searchTerm: string,
  expectedOutputType?: "array" | "object",
  customPrompt?: string
): Promise<RequestSelectionResult> {
  if (!openai) {
    throw new Error("OpenAI client not initialized");
  }

  if (matches.length === 0) {
    throw new Error("No matches provided");
  }

  // Filter out invalid matches early
  const validMatches = matches.filter((match) => {
    // Must have response body
    if (!match.responseBody || match.responseBody.trim().length === 0) {
      return false;
    }

    // Prefer successful responses (2xx), but keep others as fallback
    const statusCode = getStatusCode(match.response);
    if (statusCode >= 400 && statusCode < 600) {
      // Keep error responses but they'll be lower priority
      return true;
    }

    return true;
  });

  if (validMatches.length === 0) {
    throw new Error("No valid matches with response bodies");
  }

  if (validMatches.length === 1) {
    return {
      selectedIndex: 0,
      reasoning: "Only one valid match found, using it by default",
    };
  }

  console.log(
    `\n=== SELECTING BEST REQUEST FROM ${validMatches.length} VALID MATCHES ===`
  );

  // Calculate dynamic preview length based on number of matches to stay within token limits
  // Estimate: ~2000 tokens for system message + prompt structure
  // Remaining: ~6000 tokens for request summaries (assuming 128k context window)
  // Per request: ~300-500 tokens, so we can fit ~12-20 requests
  // If we have more, reduce preview length
  const estimatedTokensPerRequest = 400;
  const maxTotalTokens = 6000;
  const basePreviewLength = 500;
  const maxPreviewLength = Math.max(
    200,
    Math.floor(
      basePreviewLength *
        Math.min(
          1,
          maxTotalTokens / (estimatedTokensPerRequest * validMatches.length)
        )
    )
  );

  // Prepare request summaries for LLM
  const requestSummaries = validMatches.map((match, index) => {
    const request = match.request;
    const response = match.response;
    const responseBody = match.responseBody || "";
    const contentType = getContentType(response);
    const statusCode = getStatusCode(response);
    const method = request.method();
    const url = request.url();
    const bodyLength = responseBody.length;
    const containsSearch = responseBody
      .toLowerCase()
      .includes(searchTerm.toLowerCase());

    const isJSON = isJSONContentType(contentType);
    const isHTML = isHTMLContentType(contentType);

    // Generate preview with safe parsing
    const preview = generatePreview(responseBody, isJSON);

    // Truncate preview to calculated length
    const truncatedPreview = truncateForTokens(preview, maxPreviewLength / 4);

    return {
      index,
      method,
      url,
      statusCode,
      contentType,
      bodyLength,
      containsSearch,
      isJSON,
      isHTML,
      preview: truncatedPreview,
      isError: statusCode >= 400,
    };
  });

  // Escape search term for prompt (handle special characters)
  const escapedSearchTerm = searchTerm
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");

  // Build output type hint section
  const outputTypeHint = expectedOutputType
    ? `\nIMPORTANT OUTPUT TYPE HINT:
- The user expects the output to be: "${expectedOutputType}"
- When evaluating requests, prioritize those that would produce "${expectedOutputType}" output (array vs single object)
- If "${expectedOutputType}" is "array", prefer requests with array structures in their responses
`
    : "";

  // Build custom prompt section (escape it too)
  const escapedCustomPrompt = customPrompt
    ? customPrompt.replace(/"/g, '\\"').replace(/\n/g, "\\n")
    : "";
  const customPromptSection = escapedCustomPrompt
    ? `\nCUSTOM USER INSTRUCTIONS:
${escapedCustomPrompt}

Please consider these instructions when selecting the best request.
`
    : "";

  // Build request descriptions, prioritizing successful responses
  const requestDescriptions = requestSummaries
    .map(
      (req, i) => `
Request #${i + 1}:
- Method: ${req.method}
- URL: ${req.url}
- Status: ${req.statusCode}${req.isError ? " (ERROR - lower priority)" : ""}
- Content-Type: ${req.contentType}
- Response Body Length: ${req.bodyLength} characters
- Contains Search Term: ${req.containsSearch ? "Yes" : "No"}
- Preview:
${req.preview}
`
    )
    .join("\n---\n");

  const prompt = `You are an expert at analyzing API requests and responses. I have ${validMatches.length} HTTP requests that all contain the search term "${escapedSearchTerm}". I need you to select the BEST request for scraping data.${outputTypeHint}${customPromptSection}

Here are the ${validMatches.length} requests:

${requestDescriptions}

Please analyze each request and select the BEST one for scraping. Consider:
1. Data Quality: Which response contains the most complete, structured data?
2. Completeness: Which response has the most relevant data?
3. Relevance: Which response best matches the search term in context?
4. Content Type: JSON is preferred over HTML for structured data, but HTML can work if it's the only option
5. Response Size: Appropriate size for the data (not too small = incomplete, not too large = hard to process)
6. Status Code: Prefer successful responses (2xx) over error responses (4xx, 5xx)

IMPORTANT: The selectedIndex should be 0-based (0 for Request #1, 1 for Request #2, etc.)

Respond with ONLY a JSON object in this exact format:
{
  "selectedIndex": <0-based index of selected request>,
  "reasoning": "<brief explanation of why this request was selected>",
  "scores": {
    "<index>": {
      "dataQuality": <0-10>,
      "completeness": <0-10>,
      "relevance": <0-10>,
      "contentType": <0-10>,
      "total": <sum of all scores>
    }
  }
}

Return ONLY valid JSON, no markdown, no code blocks, no explanations outside the JSON.`;

  try {
    const responseText = await callOpenAIWithRetry([
      {
        role: "system",
        content:
          "You are an expert at analyzing API requests and selecting the best one for data scraping. Always return valid JSON only.",
      },
      {
        role: "user",
        content: prompt,
      },
    ]);

    console.log(
      `✅ LLM selection response received (${responseText.length} chars)`
    );

    // Extract JSON from response
    const jsonText = extractJSONFromText(responseText);

    if (!jsonText) {
      throw new Error("Could not extract JSON from LLM response");
    }

    // Parse and validate
    let result: RequestSelectionResult;
    try {
      result = JSON.parse(jsonText) as RequestSelectionResult;
    } catch (parseError) {
      throw new Error(
        `Failed to parse JSON: ${
          parseError instanceof Error ? parseError.message : String(parseError)
        }`
      );
    }

    // Validate and normalize the result (using validMatches length)
    result = validateRequestSelectionResult(result, validMatches.length);

    // Map the selected index back to original matches array
    const selectedValidMatch = validMatches[result.selectedIndex];
    if (!selectedValidMatch) {
      // Should not happen after validation, but handle gracefully
      console.warn(
        `⚠️  Selected match at index ${result.selectedIndex} is undefined, using index 0`
      );
      result.selectedIndex = 0;
    } else {
      const originalIndex = matches.indexOf(selectedValidMatch);
      if (originalIndex === -1) {
        // Should not happen, but handle gracefully - use the index from validMatches
        console.warn(
          `⚠️  Selected match not found in original array, using index from validMatches`
        );
        // The selectedIndex is already relative to validMatches, which is what we want
      } else {
        // Update selectedIndex to point to the original matches array
        result.selectedIndex = originalIndex;
      }
    }

    console.log(
      `✅ Selected request #${result.selectedIndex + 1}: ${result.reasoning}`
    );

    return result;
  } catch (error) {
    console.error(
      `❌ Request selection failed:`,
      error instanceof Error ? error.message : error
    );
    // Fallback to first valid match
    console.log("⚠️  Falling back to first valid match");
    return {
      selectedIndex: 0,
      reasoning:
        "Selection failed, using first valid match as fallback: " +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}
