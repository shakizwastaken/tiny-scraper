import OpenAI from "openai";
import type { Page } from "puppeteer";
import { type ScrapingInstructions } from "../types";
import { detectResponseType } from "../utils/response-detector";
import { validateScrapingInstructions } from "../validators/scraping.validator";
import { OPENAI_MODEL, OPENAI_MAX_TOKENS, OPENAI_TEMPERATURE } from "../config";
import { extractPaginationContext } from "../utils/pagination-detector";
import { PaginationAnalyzer } from "./pagination-analyzer.service";

/**
 * Estimate token count for text (rough approximation: ~4 chars per token)
 * This is a conservative estimate - actual tokens may be slightly less
 */
function estimateTokens(text: string): number {
  // Rough estimate: 4 characters per token (conservative)
  // For more accuracy, we could use tiktoken, but this is sufficient for truncation
  return Math.ceil(text.length / 4);
}

/**
 * Truncate text to fit within token limit
 */
function truncateToTokenLimit(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4; // Conservative: 4 chars per token
  if (text.length <= maxChars) {
    return text;
  }
  return text.substring(0, maxChars) + "\n\n... (truncated due to token limit)";
}

/**
 * Generate scraping instructions using GPT
 */
export async function generateScrapingInstructions(
  openai: OpenAI | null,
  requestUrl: string,
  method: string,
  headers: Record<string, string>,
  postData: string | undefined,
  context: string,
  contentType: string | undefined,
  fullResponseBody: string,
  useFullResponse: boolean = false,
  expectedOutputType?: "array" | "object",
  customPrompt?: string,
  page?: Page,
  responseHeaders?: Record<string, string>
): Promise<ScrapingInstructions | null> {
  if (!openai) {
    console.log("   ⚠️  OpenAI client not initialized (missing API key)");
    return null;
  }

  // Detect response type
  const responseType = detectResponseType(contentType, fullResponseBody) as
    | "json"
    | "html";
  console.log("\n=== CALLING GPT FOR SCRAPING INSTRUCTIONS ===");
  console.log(`   Model: ${OPENAI_MODEL}`);
  console.log(`   Detected response type: ${responseType}`);
  console.log(`   Context length: ${context.length} chars`);

  const baseUrl = requestUrl.split("?")[0];

  // Use comprehensive pagination analyzer
  let paginationAnalysis = null;
  let paginationHintsSection = `
PAGINATION ANALYSIS:
- No clear pagination patterns detected in URL or response
- If pagination exists, it may use non-standard parameter names
- Analyze the request/response carefully for any pagination indicators
`;

  try {
    const analyzer = new PaginationAnalyzer(openai);
    const parsedBody = postData
      ? (() => {
          try {
            return JSON.parse(postData);
          } catch {
            return postData;
          }
        })()
      : undefined;

    paginationAnalysis = await analyzer.analyzeAllPaginationTypes(
      requestUrl,
      method,
      headers,
      parsedBody,
      fullResponseBody,
      responseType as "json" | "html",
      responseHeaders || {},
      page
    );

    // Build comprehensive pagination hints section
    if (paginationAnalysis.candidates.length > 0) {
      const bestCandidate = paginationAnalysis.bestCandidate;
      const testResults = paginationAnalysis.testResults.filter(
        (tr) => tr.passed
      );

      paginationHintsSection = `
COMPREHENSIVE PAGINATION DETECTION & TESTING RESULTS:

DETECTED CANDIDATES (${paginationAnalysis.candidates.length}):
${paginationAnalysis.candidates
  .map(
    (c, i) => `
${i + 1}. Type: ${c.type}, Location: ${c.location}, Pattern: ${
      c.pattern
    }, Confidence: ${(c.confidence * 100).toFixed(1)}%
   ${
     c.testResults?.passed
       ? "✅ TEST PASSED"
       : c.testResults?.tested
       ? "❌ TEST FAILED"
       : "⏳ NOT TESTED"
   }
   ${c.testResults?.error ? `   Error: ${c.testResults.error}` : ""}
`
  )
  .join("")}

${
  bestCandidate
    ? `
BEST CANDIDATE (RECOMMENDED):
- Type: ${bestCandidate.type}
- Location: ${bestCandidate.location}
- Pattern: ${bestCandidate.pattern}
- Confidence: ${(bestCandidate.confidence * 100).toFixed(1)}%
- Test Results: ${bestCandidate.testResults?.passed ? "✅ PASSED" : "❌ FAILED"}
${
  bestCandidate.testResults?.itemCounts
    ? `- Page 1 Items: ${bestCandidate.testResults.itemCounts.page1}, Page 2 Items: ${bestCandidate.testResults.itemCounts.page2}`
    : ""
}
${
  paginationAnalysis.firstPageBehavior
    ? `
- First Page Behavior: ${
        paginationAnalysis.firstPageBehavior.different
          ? "Different (prefer " +
            paginationAnalysis.firstPageBehavior.preferredApproach +
            ")"
          : "Same as other pages"
      }
`
    : ""
}
`
    : ""
}

TEST RESULTS:
${
  testResults.length > 0
    ? testResults
        .map(
          (tr, i) => `
${i + 1}. ${tr.pattern.location}: ${
            tr.passed ? "✅ PASSED" : "❌ FAILED"
          } (Confidence: ${(tr.confidence * 100).toFixed(1)}%)
   ${
     tr.itemCounts
       ? `Items: Page 1=${tr.itemCounts.page1}, Page 2=${tr.itemCounts.page2}`
       : ""
   }
   ${tr.error ? `Error: ${tr.error}` : ""}
`
        )
        .join("")
    : "No tests passed"
}

PAGINATION CONTEXT FROM RESPONSE:
${extractPaginationContext(fullResponseBody) || "(No pagination context found)"}
`;
    }
  } catch (e) {
    console.log(
      "   ⚠️  Comprehensive pagination analysis error, using basic detection:",
      e
    );
    // Fallback to basic detection if comprehensive analysis fails
    const {
      detectPaginationFromUrl,
      detectPaginationFromHTML,
      detectPaginationFromJSON,
    } = await import("../utils/pagination-detector");
    const urlHints = detectPaginationFromUrl(requestUrl);
    let responseHints = {};
    try {
      if (responseType === "json") {
        const json = JSON.parse(fullResponseBody);
        responseHints = detectPaginationFromJSON(json);
      } else {
        responseHints = detectPaginationFromHTML(fullResponseBody);
      }
    } catch (err) {
      // Ignore
    }

    if (urlHints.detectedPattern || (responseHints as any).detectedPattern) {
      paginationHintsSection = `
PAGINATION DETECTION HINTS (Basic):
${urlHints.detectedPattern ? `- URL Pattern: ${urlHints.detectedPattern}` : ""}
${
  (responseHints as any).detectedPattern
    ? `- Response Pattern: ${(responseHints as any).detectedPattern}`
    : ""
}
`;
    }
  }

  const responseContent = useFullResponse ? fullResponseBody : context;

  // Build output type hint section
  const outputTypeHint = expectedOutputType
    ? `\nIMPORTANT OUTPUT TYPE HINT:
   - The user expects the output to be: "${expectedOutputType}"
   - You should set "outputType" to "${expectedOutputType}" unless the response structure clearly indicates otherwise.
   - If "${expectedOutputType}" is "array", ensure you provide a containerSelector (for HTML) or rootPath pointing to an array (for JSON).
`
    : "";

  // Build custom prompt section
  const customPromptSection = customPrompt
    ? `\nCUSTOM USER INSTRUCTIONS:
${customPrompt}
\nPlease incorporate these instructions into your analysis and generated scraping instructions.
`
    : "";

  // Build prompt structure (without response content) to estimate tokens
  const promptStructure = `You are an expert API analyst. Analyze this API response and generate comprehensive scraping instructions in JSON format.

Request Details:
- URL: ${requestUrl}
- Method: ${method}
- Headers: ${JSON.stringify(headers, null, 2)}
${postData ? `- Request Body: ${postData}` : ""}

${paginationHintsSection}${outputTypeHint}${customPromptSection}
Response Analysis:
- Detected Type: ${responseType}
${
  useFullResponse
    ? `- Full Response Body (${fullResponseBody.length} characters):`
    : `- Response Context (search term is centered in the middle):`
}
`;

  // Calculate token limits
  // TPM limit: 400,000 tokens
  // Reserve: system message (~1000) + prompt structure + max output (4000) + safety margin
  const TPM_LIMIT = 400000;
  const SYSTEM_MESSAGE_TOKENS = 1000;
  const OUTPUT_TOKENS = OPENAI_MAX_TOKENS;
  const SAFETY_MARGIN = 10000; // Safety margin for token estimation inaccuracy

  const promptStructureTokens = estimateTokens(promptStructure);
  const reservedTokens =
    SYSTEM_MESSAGE_TOKENS +
    promptStructureTokens +
    OUTPUT_TOKENS +
    SAFETY_MARGIN;
  const maxContentTokens = TPM_LIMIT - reservedTokens;

  // Ensure we have at least some tokens for content (minimum 10k)
  const availableContentTokens = Math.max(10000, maxContentTokens);

  console.log(`   📊 Token estimation:`);
  console.log(`      - Prompt structure: ~${promptStructureTokens} tokens`);
  console.log(
    `      - Reserved (system + structure + output + margin): ~${reservedTokens} tokens`
  );
  console.log(
    `      - Available for content: ~${availableContentTokens} tokens`
  );
  console.log(
    `      - Content size: ${responseContent.length} chars (~${estimateTokens(
      responseContent
    )} tokens)`
  );

  // Truncate response content if needed
  let truncatedContent = responseContent;
  if (estimateTokens(responseContent) > availableContentTokens) {
    const originalLength = responseContent.length;
    truncatedContent = truncateToTokenLimit(
      responseContent,
      availableContentTokens
    );
    console.log(
      `   ⚠️  Content truncated from ${originalLength} to ${truncatedContent.length} chars to fit token limit`
    );
  }

  const prompt = `${promptStructure}${truncatedContent}

CRITICAL REQUIREMENTS - Generate a complete JSON object with the following:

1. RESPONSE TYPE & OUTPUT TYPE:
   - "responseType": "${responseType}" (json, html, or xml)
   - "outputType": "array" or "object" (explicitly indicate if response is an array of items or a single object)${
     expectedOutputType ? ` (User expects: "${expectedOutputType}")` : ""
   }

2. DATA EXTRACTION - SELECTORS ONLY:

   For HTML/XML responses:
   - "extraction" object with:
     - "type": "css" | "xpath" | "mixed" (prefer CSS when possible)
     - "containerSelector": CSS selector or XPath for each item (if outputType is "array")
     - "selectors": Object mapping field names to selectors
       * Format: "fieldName": ".css-selector::text" or ".css-selector::attr(attributeName)"
       * For text: use "::text" suffix
       * For attributes: use "::attr(attrName)" suffix
       * For HTML content: use "::html" suffix
       * For XPath: use full XPath expression

   For JSON responses:
   - "jsonPath" object with:
     - "rootPath": JSONPath to data root (e.g., "$.data.items" or "$.results")
     - "fieldPaths": Object mapping field names to JSONPath expressions
       * Format: "fieldName": "$.path.to.field" or "$.array[*].field"

   NOTE: The schema will be automatically generated from the extracted data. You only need to provide the selectors.

3. PAGINATION (only if pagination exists, otherwise omit entirely):
   CRITICAL: Only include pagination if you can clearly identify pagination patterns. If uncertain, omit it.
   
   If pagination is detected:
   - "pagination" object with:
     - "type": "query" | "body" | "header" | "response"
       * Use "query" if pagination is in URL query parameters (e.g., ?page=1)
       * Use "body" if pagination is in request body (e.g., POST/PUT with {"page": 1})
       * Use "header" if pagination is in headers (rare)
       * Use "response" if pagination info comes from response (e.g., {"nextPage": "url"})
     - "location": exact path (e.g., "query.page", "body.pagination.page", "body.page")
       * For query: "query.{paramName}" where paramName is the actual query param
       * For body: "body.{path.to.field}" using dot notation
       * For response: "response.{path.to.nextPageUrl}"
     - "placeholder": "{{page}}" or "{{offset}}" or "{{cursor}}" etc.
       * Use "{{page}}" for page-based pagination (1, 2, 3...)
       * Use "{{offset}}" for offset-based (0, 20, 40...)
       * Use "{{cursor}}" for cursor-based (tokens, IDs)
     - "initialValue": starting value (usually 1 for pages, 0 for offsets)
   
   Common patterns:
   - Page-based: type="query", location="query.page", placeholder="{{page}}", initialValue=1
   - Offset-based: type="query", location="query.offset", placeholder="{{offset}}", initialValue=0
   - Body pagination: type="body", location="body.page", placeholder="{{page}}", initialValue=1
   
   If NO pagination exists, do NOT include the "pagination" field at all.

4. REQUEST STRUCTURE:
   - "body": structure with placeholders (if POST/PUT/PATCH)
   - "queryParams": structure with placeholders
   - "headers": dynamic and static headers

IMPORTANT:
- Use placeholders like {{page}}, {{offset}}, {{limit}}, {{cursor}} for dynamic values
- Be extremely precise with selectors - they must work for actual scraping
- For HTML arrays, containerSelector is REQUIRED
- You only need to provide SELECTORS - the schema will be generated automatically from extracted data
- Return ONLY valid JSON, no markdown, no code blocks, no explanations

Expected JSON structure (schema is NOT needed):
{
  "method": "${method}",
  "baseUrl": "${baseUrl}",
  "responseType": "${responseType}",
  "outputType": "array" | "object",
  ${
    responseType === "json"
      ? `"jsonPath": {
    "rootPath": "$.path.to.data",
    "fieldPaths": {
      "field1": "$.path.to.field1",
      "field2": "$.path.to.field2"
    }
  }`
      : `"extraction": {
    "type": "css",
    "containerSelector": ".item-selector",
    "selectors": {
      "field1": ".field1-selector::text",
      "field2": ".field2-selector::attr(data-value)"
    }
  }`
  },
  "pagination": { ... } (only if pagination exists),
  "body": { ... },
  "queryParams": { ... },
  "headers": { ... }
}`;

  try {
    // Final token check before API call
    const systemMessage =
      "You are an expert API analyst. Generate JSON scraping instructions based on API responses. You only need to provide selectors for data extraction - the schema will be generated automatically. Always return valid JSON only.";
    const totalInputTokens =
      estimateTokens(systemMessage) + estimateTokens(prompt);
    const totalTokens = totalInputTokens + OUTPUT_TOKENS;

    console.log(`   📊 Final token check:`);
    console.log(
      `      - System message: ~${estimateTokens(systemMessage)} tokens`
    );
    console.log(`      - User prompt: ~${estimateTokens(prompt)} tokens`);
    console.log(`      - Max output: ${OUTPUT_TOKENS} tokens`);
    console.log(
      `      - Total estimated: ~${totalTokens} tokens (limit: ${TPM_LIMIT})`
    );

    if (totalTokens > TPM_LIMIT) {
      const excess = totalTokens - TPM_LIMIT;
      console.error(`   ❌ Token limit exceeded by ~${excess} tokens`);
      throw new Error(
        `Request too large: Estimated ${totalTokens} tokens exceeds TPM limit of ${TPM_LIMIT}. ` +
          `Please reduce the response size or use a smaller context window.`
      );
    }

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: systemMessage,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      max_tokens: OPENAI_MAX_TOKENS,
      temperature: OPENAI_TEMPERATURE,
    });

    const responseText = completion.choices[0]?.message?.content?.trim() || "";
    console.log(`   ✅ GPT response received (${responseText.length} chars)`);

    // Try to extract JSON from response (handle markdown code blocks if present)
    let jsonText = responseText;
    const jsonMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    if (jsonMatch) jsonText = jsonMatch[1] || "";

    const instructions = JSON.parse(jsonText) as ScrapingInstructions;
    console.log("   ✅ Scraping instructions parsed successfully");

    // Validate structure (but schema is optional)
    validateScrapingInstructions(instructions);

    // Capture cookies from Puppeteer page if available
    if (page) {
      try {
        const cookies = await page.cookies();
        if (cookies.length > 0) {
          const cookieString = cookies
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; ");
          instructions.cookies = cookieString;
          console.log(
            `   ✅ Captured ${cookies.length} cookie(s) from browser session`
          );
        }
      } catch (cookieError) {
        console.warn(
          "   ⚠️  Failed to capture cookies:",
          cookieError instanceof Error ? cookieError.message : cookieError
        );
      }
    }

    // If pagination analysis found a best candidate, use it to set pagination in instructions
    if (paginationAnalysis?.bestCandidate && !instructions.pagination) {
      const analyzer = new PaginationAnalyzer(openai);
      const paginationConfig = analyzer.generatePaginationInstructions(
        paginationAnalysis.bestCandidate
      );
      if (paginationConfig) {
        instructions.pagination = paginationConfig;
        console.log("   ✅ Pagination configuration added from analysis");
      }
    }

    // Schema will be generated automatically when we first extract data
    // For now, we just return the instructions with selectors

    return instructions;
  } catch (error) {
    console.error(
      "   ❌ GPT call failed:",
      error instanceof Error ? error.message : error
    );

    // Handle token limit errors specifically
    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();
      if (
        errorMessage.includes("429") ||
        errorMessage.includes("token") ||
        errorMessage.includes("tpm") ||
        errorMessage.includes("too large")
      ) {
        throw new Error(
          `Token limit exceeded. The response is too large for the model's TPM limit. ` +
            `Try using a smaller search term or reducing the response size. ` +
            `Original error: ${error.message}`
        );
      }
    }

    throw error;
  }
}
