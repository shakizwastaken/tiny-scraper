import OpenAI from "openai";
import { type ScrapingInstructions } from "../types";
import { detectResponseType } from "../utils/response-detector";
import { validateScrapingInstructions } from "../validators/scraping.validator";
import { OPENAI_MODEL, OPENAI_MAX_TOKENS, OPENAI_TEMPERATURE } from "../config";
import {
  detectPaginationFromUrl,
  detectPaginationFromHTML,
  detectPaginationFromJSON,
  extractPaginationContext,
  type PaginationHints,
} from "../utils/pagination-detector";

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
  useFullResponse: boolean = false
): Promise<ScrapingInstructions | null> {
  if (!openai) {
    console.log("   ⚠️  OpenAI client not initialized (missing API key)");
    return null;
  }

  // Detect response type
  const responseType = detectResponseType(contentType, fullResponseBody);
  console.log("\n=== CALLING GPT FOR SCRAPING INSTRUCTIONS ===");
  console.log(`   Model: ${OPENAI_MODEL}`);
  console.log(`   Detected response type: ${responseType}`);
  console.log(`   Context length: ${context.length} chars`);

  const baseUrl = requestUrl.split("?")[0];

  // Detect pagination hints
  const urlHints = detectPaginationFromUrl(requestUrl);
  let responseHints: PaginationHints = {};

  try {
    if (responseType === "json") {
      const json = JSON.parse(fullResponseBody);
      responseHints = detectPaginationFromJSON(json);
    } else {
      responseHints = detectPaginationFromHTML(fullResponseBody);
    }
  } catch (e) {
    // Ignore errors in pagination detection
    console.log("   ⚠️  Pagination detection error, continuing without hints");
  }

  // Extract pagination context
  const paginationContext = extractPaginationContext(fullResponseBody);

  // Build pagination hints section
  const paginationHintsSection =
    urlHints.detectedPattern || responseHints.detectedPattern
      ? `
PAGINATION DETECTION HINTS:
${
  urlHints.detectedPattern
    ? `- URL Pattern Detected: ${urlHints.detectedPattern}`
    : ""
}
${
  urlHints.queryParams && Object.keys(urlHints.queryParams).length > 0
    ? `- URL Query Params: ${JSON.stringify(urlHints.queryParams)}`
    : ""
}
${
  responseHints.bodyParams && Object.keys(responseHints.bodyParams).length > 0
    ? `- Response Pagination Fields: ${JSON.stringify(
        responseHints.bodyParams
      )}`
    : ""
}
${
  responseHints.hasPaginationControls
    ? `- HTML contains pagination controls (links, buttons, etc.)`
    : ""
}
${
  urlHints.examples && urlHints.examples.length > 0
    ? `- Example patterns found: ${urlHints.examples.join(", ")}`
    : ""
}

PAGINATION CONTEXT FROM RESPONSE:
${paginationContext || "(No pagination context found)"}
`
      : `
PAGINATION ANALYSIS:
- No clear pagination patterns detected in URL or response
- If pagination exists, it may use non-standard parameter names
- Analyze the request/response carefully for any pagination indicators
`;

  const responseContent = useFullResponse ? fullResponseBody : context;

  const prompt = `You are an expert API analyst. Analyze this API response and generate comprehensive scraping instructions in JSON format.

Request Details:
- URL: ${requestUrl}
- Method: ${method}
- Headers: ${JSON.stringify(headers, null, 2)}
${postData ? `- Request Body: ${postData}` : ""}

${paginationHintsSection}

Response Analysis:
- Detected Type: ${responseType}
${
  useFullResponse
    ? `- Full Response Body (${fullResponseBody.length} characters):`
    : `- Response Context (search term is centered in the middle):`
}
${responseContent}

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

4. PAGINATION (REQUIRED if pagination exists, otherwise omit entirely):
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
      model: OPENAI_MODEL,
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
