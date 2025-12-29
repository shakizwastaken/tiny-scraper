import OpenAI from "openai";
import { type ScrapingInstructions } from "../types";
import { detectResponseType } from "../utils/response-detector";
import { validateScrapingInstructions } from "../validators/scraping.validator";
import {
  OPENAI_MODEL,
  OPENAI_MAX_TOKENS,
  OPENAI_TEMPERATURE,
} from "../config";

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
  fullResponseBody: string
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

