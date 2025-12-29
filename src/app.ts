import express from "express";
import puppeteer, { Browser, Page, HTTPRequest, HTTPResponse } from "puppeteer";
import OpenAI from "openai";

const app = express();

app.use(express.json());

// Load OpenAI API key from environment
const openaiApiKey = process.env.OPENAI_API_KEY;
if (!openaiApiKey) {
  console.warn("⚠️  OPENAI_API_KEY not found in environment variables");
}

const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  format?: string;
  description?: string;
}

interface ExtractionSelector {
  selector: string; // CSS selector, XPath, or JSONPath
  type?: "text" | "attr" | "html" | "jsonpath"; // Extraction type
  attribute?: string; // For attr type, which attribute to extract
}

interface ScrapingInstructions {
  method: string;
  baseUrl: string;
  responseType: "json" | "html" | "xml";
  outputType: "array" | "object";

  // For HTML/XML responses
  extraction?: {
    type: "css" | "xpath" | "jsonpath" | "mixed";
    containerSelector?: string; // For arrays: selector for each item
    selectors: Record<string, string | ExtractionSelector>; // Field -> selector mapping
  };

  // For JSON responses
  jsonPath?: {
    rootPath?: string; // Path to data root (e.g., "$.data.items")
    fieldPaths: Record<string, string>; // Field -> JSONPath mapping
  };

  // Output schema (JSON Schema format)
  schema: JSONSchema;

  // Pagination
  pagination?: {
    type: "query" | "body" | "header" | "response";
    location: string; // e.g., "query.page", "body.offset", "response.nextPage"
    placeholder: string; // e.g., "{{page}}", "{{offset}}"
    initialValue?: string | number;
  };

  // Request structure
  body?: {
    structure: Record<string, any>; // JSON structure with placeholders
    placeholders: string[]; // List of placeholder keys
  };
  queryParams?: {
    structure: Record<string, any>;
    placeholders: string[];
  };
  headers?: {
    dynamic: Record<string, string>; // Headers that might need placeholders
    static: Record<string, string>; // Static headers
  };
}

interface RequestMetadata {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  scrapingInstructions?: ScrapingInstructions;
  gptError?: string;
}

interface InterceptedRequest {
  request: HTTPRequest;
  response?: HTTPResponse;
  responseBody?: string;
}

/**
 * Detect response type from content-type header and body structure
 */
function detectResponseType(
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

/**
 * Extract context around the search term, centering it in the available context window
 */
function extractContextAroundSearchTerm(
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

/**
 * Generate scraping instructions using GPT
 */
async function generateScrapingInstructions(
  requestUrl: string,
  method: string,
  headers: Record<string, string>,
  postData: string | undefined,
  context: string,
  contentType: string | undefined,
  fullResponseBody: string
): Promise<ScrapingInstructions | null> {
  if (!openai) {
    console.log("   ⚠️  OpenAI client not initialized (missing API key)");
    return null;
  }

  // Detect response type
  const responseType = detectResponseType(contentType, fullResponseBody);
  console.log("\n=== CALLING GPT FOR SCRAPING INSTRUCTIONS ===");
  console.log("   Model: gpt-4.1-mini-2025-04-14");
  console.log(`   Detected response type: ${responseType}`);
  console.log(`   Context length: ${context.length} chars`);

  const baseUrl = requestUrl.split("?")[0];

  const prompt = `You are an expert API analyst. Analyze this API response and generate comprehensive scraping instructions in JSON format.

Request Details:
- URL: ${requestUrl}
- Method: ${method}
- Headers: ${JSON.stringify(headers, null, 2)}
${postData ? `- Request Body: ${postData}` : ""}

Response Analysis:
- Detected Type: ${responseType}
- Response Context (search term is centered in the middle):
${context}

CRITICAL REQUIREMENTS - Generate a complete JSON object with ALL of the following:

1. RESPONSE TYPE & OUTPUT TYPE:
   - "responseType": "${responseType}" (json, html, or xml)
   - "outputType": "array" or "object" (explicitly indicate if response is an array of items or a single object)

2. DATA EXTRACTION INSTRUCTIONS:

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

3. JSON SCHEMA (REQUIRED):
   Generate a complete JSON Schema following JSON Schema Draft 7+ specification:
   - "schema" object with:
     - "type": "array" or "object" (must match outputType)
     - If "array": include "items" with schema for each item
     - If "object": include "properties" with schema for each property
     - Include "required" array listing required fields
     - For each property, include: "type" (string, number, boolean, object, array)
     - For strings: optionally include "format" (uri, email, date-time, etc.)
     - For nested objects: include full nested schema
     - For arrays: include "items" schema

   Example for array output:
   {
     "type": "array",
     "items": {
       "type": "object",
       "properties": {
         "title": { "type": "string" },
         "price": { "type": "number" },
         "url": { "type": "string", "format": "uri" }
       },
       "required": ["title", "price"]
     }
   }

4. PAGINATION (if applicable):
   - "pagination" object with:
     - "type": "query" | "body" | "header" | "response"
     - "location": exact path (e.g., "query.page", "body.offset", "response.nextPage")
     - "placeholder": "{{page}}" or "{{offset}}" etc.
     - "initialValue": starting value

5. REQUEST STRUCTURE:
   - "body": structure with placeholders (if POST/PUT/PATCH)
   - "queryParams": structure with placeholders
   - "headers": dynamic and static headers

IMPORTANT:
- Use placeholders like {{page}}, {{offset}}, {{limit}}, {{cursor}} for dynamic values
- Be extremely precise with selectors - they must work for actual scraping
- Schema must accurately represent the data structure
- For HTML arrays, containerSelector is REQUIRED
- Return ONLY valid JSON, no markdown, no code blocks, no explanations

Expected JSON structure:
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
  },`
      : `"extraction": {
    "type": "css",
    "containerSelector": ".item-selector",
    "selectors": {
      "field1": ".field1-selector::text",
      "field2": ".field2-selector::attr(data-value)"
    }
  },`
  }
  "schema": {
    "type": "array" | "object",
    ...
  },
  "pagination": { ... },
  "body": { ... },
  "queryParams": { ... },
  "headers": { ... }
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini-2025-04-14",
      messages: [
        {
          role: "system",
          content:
            "You are an expert API analyst. Generate comprehensive JSON scraping instructions based on API responses. Always return valid JSON only. Include complete JSON schemas, precise selectors, and all required fields.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      max_tokens: 4000, // Increased for comprehensive schema and selectors
      temperature: 0.3,
    });

    const responseText = completion.choices[0]?.message?.content?.trim() || "";
    console.log(`   ✅ GPT response received (${responseText.length} chars)`);

    // Try to extract JSON from response (handle markdown code blocks if present)
    let jsonText = responseText;
    const jsonMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    if (jsonMatch) jsonText = jsonMatch[1] || "";

    const instructions = JSON.parse(jsonText) as ScrapingInstructions;
    console.log("   ✅ Scraping instructions parsed successfully");

    // Validate schema
    validateScrapingInstructions(instructions);

    return instructions;
  } catch (error) {
    console.error(
      "   ❌ GPT call failed:",
      error instanceof Error ? error.message : error
    );
    throw error;
  }
}

/**
 * Validate scraping instructions structure
 */
function validateScrapingInstructions(
  instructions: ScrapingInstructions
): void {
  // Validate required fields
  if (!instructions.method) {
    throw new Error("Missing required field: method");
  }
  if (!instructions.baseUrl) {
    throw new Error("Missing required field: baseUrl");
  }
  if (!instructions.responseType) {
    throw new Error("Missing required field: responseType");
  }
  if (!instructions.outputType) {
    throw new Error("Missing required field: outputType");
  }
  if (!instructions.schema) {
    throw new Error("Missing required field: schema");
  }

  // Validate responseType
  if (!["json", "html", "xml"].includes(instructions.responseType)) {
    throw new Error(
      `Invalid responseType: ${instructions.responseType}. Must be json, html, or xml`
    );
  }

  // Validate outputType
  if (!["array", "object"].includes(instructions.outputType)) {
    throw new Error(
      `Invalid outputType: ${instructions.outputType}. Must be array or object`
    );
  }

  // Validate schema type matches outputType
  if (instructions.schema.type !== instructions.outputType) {
    throw new Error(
      `Schema type (${instructions.schema.type}) does not match outputType (${instructions.outputType})`
    );
  }

  // Validate extraction for HTML/XML
  if (
    instructions.responseType === "html" ||
    instructions.responseType === "xml"
  ) {
    if (!instructions.extraction) {
      throw new Error(
        `Missing extraction object for ${instructions.responseType} response type`
      );
    }
    if (
      instructions.outputType === "array" &&
      !instructions.extraction.containerSelector
    ) {
      console.warn(
        "⚠️  Warning: outputType is array but containerSelector is missing"
      );
    }
    if (
      !instructions.extraction.selectors ||
      Object.keys(instructions.extraction.selectors).length === 0
    ) {
      throw new Error("Missing or empty selectors in extraction object");
    }
  }

  // Validate jsonPath for JSON
  if (instructions.responseType === "json") {
    if (!instructions.jsonPath) {
      throw new Error("Missing jsonPath object for JSON response type");
    }
    if (
      !instructions.jsonPath.fieldPaths ||
      Object.keys(instructions.jsonPath.fieldPaths).length === 0
    ) {
      throw new Error("Missing or empty fieldPaths in jsonPath object");
    }
  }

  // Validate schema structure
  if (instructions.schema.type === "array") {
    if (!instructions.schema.items) {
      throw new Error("Schema type is array but items schema is missing");
    }
  } else if (instructions.schema.type === "object") {
    if (
      !instructions.schema.properties ||
      Object.keys(instructions.schema.properties).length === 0
    ) {
      throw new Error(
        "Schema type is object but properties are missing or empty"
      );
    }
  }

  console.log("   ✅ Scraping instructions validation passed");
}

app.get("/scrape", async (req, res) => {
  const { url, search } = req.query;

  console.log("\n=== SCRAPING REQUEST STARTED ===");
  console.log("URL:", url);
  console.log("Search term:", search);
  console.log("Timestamp:", new Date().toISOString());

  // Validate query parameters
  if (!url || typeof url !== "string") {
    console.log("❌ Validation failed: Missing or invalid 'url' parameter");
    return res
      .status(400)
      .json({ error: "Missing or invalid 'url' query parameter" });
  }

  if (!search || typeof search !== "string") {
    console.log("❌ Validation failed: Missing or invalid 'search' parameter");
    return res
      .status(400)
      .json({ error: "Missing or invalid 'search' query parameter" });
  }

  console.log("✅ Parameters validated");

  let browser: Browser | null = null;

  try {
    // Launch browser
    console.log("\n[1/6] Launching browser...");
    browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    console.log("✅ Browser launched successfully");

    console.log("\n[2/6] Creating new page...");
    const page = await browser.newPage();
    const interceptedRequests: InterceptedRequest[] = [];
    console.log("✅ Page created");

    // Enable request interception
    console.log("\n[3/6] Setting up request interception...");
    await page.setRequestInterception(true);
    console.log("✅ Request interception enabled");

    let requestCount = 0;
    let responseCount = 0;
    let responseBodyReadCount = 0;
    let responseBodyReadFailCount = 0;

    // Intercept requests
    page.on("request", (request: HTTPRequest) => {
      requestCount++;
      console.log(
        `📤 [REQUEST #${requestCount}] ${request.method()} ${request.url()}`
      );
      // Continue the request
      request.continue();
    });

    // Intercept responses and store them
    page.on("response", async (response: HTTPResponse) => {
      responseCount++;
      const request = response.request();
      const status = response.status();
      const contentType = response.headers()["content-type"] || "";

      console.log(
        `📥 [RESPONSE #${responseCount}] ${status} ${request.method()} ${request.url()}`
      );
      console.log(`   Content-Type: ${contentType || "(none)"}`);

      let responseBody: string | undefined;

      try {
        // Try to get response body
        if (
          contentType.includes("text") ||
          contentType.includes("json") ||
          contentType.includes("javascript") ||
          contentType.includes("xml") ||
          contentType.includes("html")
        ) {
          responseBody = await response.text();
          responseBodyReadCount++;
          const bodyLength = responseBody.length;
          const bodyPreview =
            bodyLength > 200
              ? responseBody.substring(0, 200) + "..."
              : responseBody;
          console.log(
            `   ✅ Response body read (${bodyLength} chars): ${bodyPreview}`
          );
        } else {
          console.log(
            `   ⚠️  Skipping response body read (content-type: ${contentType})`
          );
        }
      } catch (error) {
        responseBodyReadFailCount++;
        console.log(
          `   ❌ Failed to read response body:`,
          error instanceof Error ? error.message : error
        );
      }

      interceptedRequests.push({
        request,
        response,
        responseBody,
      });
    });

    // Navigate to the URL and wait for network to be idle
    console.log("\n[4/6] Navigating to URL...");
    console.log(`   Target: ${url}`);
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    console.log("✅ Navigation completed");

    // Wait a bit more to ensure all responses are captured
    console.log("\n[5/6] Waiting for all responses to be processed...");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log("✅ Wait complete");

    console.log("\n=== INTERCEPTION SUMMARY ===");
    console.log(`Total requests intercepted: ${requestCount}`);
    console.log(`Total responses intercepted: ${responseCount}`);
    console.log(`Response bodies read successfully: ${responseBodyReadCount}`);
    console.log(`Response bodies read failed: ${responseBodyReadFailCount}`);
    console.log(
      `Total intercepted requests stored: ${interceptedRequests.length}`
    );

    // Filter requests where response body contains the search term (case-insensitive)
    console.log("\n[6/6] Filtering requests by search term...");
    const searchLower = search.toLowerCase();
    console.log(`   Search term (lowercase): "${searchLower}"`);
    const matchingRequests: RequestMetadata[] = [];

    for (let i = 0; i < interceptedRequests.length; i++) {
      const intercepted = interceptedRequests[i];
      if (!intercepted) continue;

      const { request, response, responseBody } = intercepted;
      const requestUrl = request.url();

      console.log(
        `\n   Checking request #${i + 1}: ${request.method()} ${requestUrl}`
      );

      if (!responseBody) {
        console.log(`   ⚠️  No response body available`);
        continue;
      }

      const bodyLower = responseBody.toLowerCase();
      const containsSearch = bodyLower.includes(searchLower);

      console.log(`   Response body length: ${responseBody.length} chars`);
      console.log(
        `   Contains search term: ${containsSearch ? "✅ YES" : "❌ NO"}`
      );

      if (containsSearch) {
        console.log(`   ✅ MATCH FOUND! Adding to results...`);
        const requestHeaders: Record<string, string> = {};
        const reqHeaders = request.headers();
        Object.entries(reqHeaders).forEach(([key, value]) => {
          requestHeaders[key] = value;
        });

        const responseHeaders: Record<string, string> = {};
        if (response) {
          const resHeaders = response.headers();
          Object.entries(resHeaders).forEach(([key, value]) => {
            responseHeaders[key] = value;
          });
        }

        // Extract non-LLM metadata
        const method = request.method();
        const postData = request.postData() || undefined;

        // Only process first matching request with GPT
        let scrapingInstructions: ScrapingInstructions | undefined;
        let gptError: string | undefined;

        if (matchingRequests.length === 0) {
          // First match - generate scraping instructions with GPT
          console.log(`\n   🤖 Processing first match with GPT...`);
          try {
            // Extract context around search term
            const context = extractContextAroundSearchTerm(
              responseBody,
              search,
              1000000 // Max tokens available
            );

            // Get content type from response headers
            const contentType = response
              ? response.headers()["content-type"] || undefined
              : undefined;

            // Generate scraping instructions
            const instructions = await generateScrapingInstructions(
              requestUrl,
              method,
              requestHeaders,
              postData,
              context,
              contentType,
              responseBody
            );

            if (instructions) {
              scrapingInstructions = instructions;
              console.log(`   ✅ Scraping instructions generated successfully`);
            }
          } catch (error) {
            gptError = error instanceof Error ? error.message : String(error);
            console.error(
              `   ❌ Failed to generate scraping instructions:`,
              gptError
            );
          }
        } else {
          console.log(
            `   ⏭️  Skipping GPT processing (only first match is processed)`
          );
        }

        matchingRequests.push({
          url: requestUrl,
          method: method,
          headers: requestHeaders,
          postData: postData,
          responseStatus: response?.status(),
          responseHeaders:
            Object.keys(responseHeaders).length > 0
              ? responseHeaders
              : undefined,
          responseBody: responseBody,
          scrapingInstructions,
          gptError,
        });
      }
    }

    console.log("\n=== FILTERING SUMMARY ===");
    console.log(`Total matching requests: ${matchingRequests.length}`);
    if (matchingRequests.length > 0) {
      console.log("Matching URLs:");
      matchingRequests.forEach((match, idx) => {
        console.log(`  ${idx + 1}. ${match.method} ${match.url}`);
      });
    }

    console.log("\n=== REQUEST COMPLETED SUCCESSFULLY ===\n");

    res.json({
      url,
      search,
      matches: matchingRequests.length,
      requests: matchingRequests,
    });
  } catch (error) {
    console.error("\n=== ERROR OCCURRED ===");
    console.error(
      "Error type:",
      error instanceof Error ? error.constructor.name : typeof error
    );
    console.error(
      "Error message:",
      error instanceof Error ? error.message : String(error)
    );
    if (error instanceof Error && error.stack) {
      console.error("Stack trace:", error.stack);
    }

    if (error instanceof Error) {
      if (error.message.includes("timeout")) {
        console.error("❌ Request timeout error");
        return res
          .status(408)
          .json({ error: "Request timeout", message: error.message });
      }
      if (error.message.includes("net::ERR")) {
        console.error("❌ Network error");
        return res
          .status(502)
          .json({ error: "Network error", message: error.message });
      }
      console.error("❌ General scraping error");
      return res
        .status(500)
        .json({ error: "Scraping failed", message: error.message });
    }

    console.error("❌ Unknown error type");
    return res.status(500).json({ error: "Unknown error occurred" });
  } finally {
    // Clean up browser instance
    console.log("\n=== CLEANUP ===");
    if (browser) {
      console.log("Closing browser...");
      await browser.close();
      console.log("✅ Browser closed");
    } else {
      console.log("⚠️  No browser instance to close");
    }
    console.log("=== END ===\n");
  }
});

export default app;
