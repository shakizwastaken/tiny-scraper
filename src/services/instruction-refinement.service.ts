import {
  type ScrapingInstructions,
  type TestResults,
  type RefinementResponse,
} from "../types";
import { openai, OPENAI_REFINEMENT_MODEL, OPENAI_MAX_TOKENS } from "../config";
import { validateScrapingInstructions } from "../validators/scraping.validator";
import { generateSchemaFromData } from "../utils/schema-generator";

export interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Refine scraping instructions based on test results
 */
export async function refineInstructions(
  instructions: ScrapingInstructions,
  testResults: TestResults,
  conversationHistory: ConversationMessage[]
): Promise<{
  response: RefinementResponse;
  updatedHistory: ConversationMessage[];
}> {
  if (!openai) throw new Error("OpenAI client not initialized");

  console.log(`\n=== REFINING INSTRUCTIONS ===`);
  console.log(`Model: ${OPENAI_REFINEMENT_MODEL}`);
  console.log(`Conversation history length: ${conversationHistory.length}`);

  // Build the user message with test results and current selectors
  const testResultsSummary = {
    success: testResults.success,
    errors: testResults.errors || [],
    extractedDataSample: testResults.extractedData,
    debugInfo: testResults.debugInfo,
    paginationTestResult: testResults.paginationTestResult,
  };

  // Extract only selectors from instructions (not schema)
  const selectorsOnly = {
    method: instructions.method,
    baseUrl: instructions.baseUrl,
    responseType: instructions.responseType,
    outputType: instructions.outputType,
    extraction: instructions.extraction,
    jsonPath: instructions.jsonPath,
    pagination: instructions.pagination,
    body: instructions.body,
    queryParams: instructions.queryParams,
    headers: instructions.headers,
  };

  // Include HTML response and container samples if available (for debugging selector issues)
  let htmlContext = "";
  if (
    testResults.debugInfo?.actualHtmlResponse &&
    (instructions.responseType === "html" ||
      instructions.responseType === "xml")
  ) {
    htmlContext = `

ACTUAL HTML RESPONSE (first ${testResults.debugInfo.htmlLength || 0} chars):
This is the actual HTML that was returned when testing the instructions. Use this to verify if selectors are correct.
${testResults.debugInfo.actualHtmlResponse.substring(0, 5000)}
${(testResults.debugInfo.htmlLength || 0) > 5000 ? "\n... (truncated)" : ""}`;

    // Include container HTML samples if available
    if (
      instructions.outputType === "array" &&
      instructions.extraction?.containerSelector &&
      testResults.debugInfo.containerHtmlSamples &&
      testResults.debugInfo.containerHtmlSamples.length > 0
    ) {
      htmlContext += `\n
CONTAINER SELECTOR: "${instructions.extraction.containerSelector}"
CONTAINER HTML SAMPLES (first ${
        testResults.debugInfo.containerHtmlSamples.length
      } containers):
These are the actual HTML elements that matched the containerSelector. Use these to verify if the containerSelector is correct.
${testResults.debugInfo.containerHtmlSamples
  .map(
    (sample: string, index: number) =>
      `\n--- Container ${index + 1} ---\n${sample}${
        sample.length >= 2000 ? "\n... (truncated)" : ""
      }`
  )
  .join("\n")}`;
    }
  }

  const userMessage = `I have tested the scraping instructions and here are the results:

TEST RESULTS:
${JSON.stringify(testResultsSummary, null, 2)}${htmlContext}

CURRENT SELECTORS:
${JSON.stringify(selectorsOnly, null, 2)}

IMPORTANT NOTES:
- The system supports UNLIMITED RECURSIVE NESTED ARRAYS - if you see arrays within arrays, use nested extraction configs
- For HTML: Use nested extraction configs with containerSelector for each array level
- For JSON: Use nested extraction configs with jsonPath for each array level
- The schema generation handles advanced JSON Schema features automatically (anyOf, allOf, oneOf, enum, constraints)
- When fixing nested array extraction, ensure each level has its own containerSelector (HTML) or jsonPath (JSON)

NOTE: You only need to modify the SELECTORS (extraction.selectors or jsonPath.fieldPaths). The schema is automatically generated from extracted data, so you don't need to provide it.

${
  instructions.pagination
    ? `NOTE: Pagination is currently configured. Verify it's working correctly.
     If test results show pagination issues (paginationTestResult), you may need to:
     - Fix the pagination type (query vs body vs header)
     - Correct the location path
     - Adjust the placeholder format
     - Set the correct initialValue`
    : `NOTE: No pagination is currently configured. If the response appears to have pagination
     (e.g., shows partial results, has "next" buttons, pagination controls in HTML),
     you should add a pagination object.`
}

Please analyze the test results and the current selectors. 

If the selectors work correctly (test passed, data extracted successfully), respond with:
{"ok": true}

If the selectors need modification, respond with:
{"ok": false, "modification": {<complete updated selectors JSON - same structure as CURRENT SELECTORS>}, "reason": "<brief explanation of what was fixed>"}

IMPORTANT:
- You're part of a bigger system that requires valid JSON ONLY, anything else will break the system.
- The "modification" must have the same structure as CURRENT SELECTORS (but with updated selectors)
- You only need to modify the SELECTORS - do NOT include a schema field
- The schema will be automatically generated from the extracted data
- If modifying, ensure all required fields are included (method, baseUrl, responseType, outputType, and either extraction or jsonPath)
- Ensure pagination and headers are at the root level of modification, NOT nested inside extraction`;

  // Add user message to history
  const updatedHistory: ConversationMessage[] = [
    ...conversationHistory,
    { role: "user" as const, content: userMessage },
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_REFINEMENT_MODEL,
      messages: updatedHistory.map((msg) => ({
        role: msg.role as "system" | "user" | "assistant",
        content: msg.content,
      })),
      max_tokens: OPENAI_MAX_TOKENS,
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    const responseText = completion.choices[0]?.message?.content?.trim() || "";
    console.log(`✅ Agent response received (${responseText.length} chars)`);

    // Extract JSON from response
    // With JSON Mode, response should be pure JSON, but we handle markdown code blocks as fallback
    let jsonText = responseText;
    const jsonMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    if (jsonMatch) {
      // Found markdown code block (shouldn't happen with JSON Mode, but handle it)
      jsonText = jsonMatch[1] || "";
      console.warn(
        "⚠️  Found markdown code block in response (unexpected with JSON Mode)"
      );
    }

    // Parse the response
    let refinementResponse: RefinementResponse;
    try {
      const parsed = JSON.parse(jsonText);

      if (parsed.ok === true) {
        refinementResponse = { ok: true };
      } else if (parsed.modification) {
        // Fix common structural issues: move pagination and headers out of extraction if nested incorrectly
        if (parsed.modification.extraction) {
          if (parsed.modification.extraction.pagination) {
            console.warn(
              "⚠️  Found pagination nested inside extraction, moving to root level"
            );
            parsed.modification.pagination =
              parsed.modification.extraction.pagination;
            delete parsed.modification.extraction.pagination;
          }
          if (parsed.modification.extraction.headers) {
            console.warn(
              "⚠️  Found headers nested inside extraction, moving to root level"
            );
            parsed.modification.headers =
              parsed.modification.extraction.headers;
            delete parsed.modification.extraction.headers;
          }
        }

        // Validate nested extraction configs if present
        const validateNestedConfig = (config: any, path: string = ""): void => {
          if (config && typeof config === "object" && config.type === "array") {
            if (!config.containerSelector && !config.jsonPath) {
              console.warn(
                `⚠️  Nested array config at ${path} missing containerSelector/jsonPath`
              );
            }
            if (!config.selectors || typeof config.selectors !== "object") {
              console.warn(
                `⚠️  Nested array config at ${path} missing selectors`
              );
            } else {
              // Recursively validate nested selectors
              Object.entries(config.selectors).forEach(([key, value]) => {
                if (
                  value &&
                  typeof value === "object" &&
                  "type" in value &&
                  (value as any).type === "array"
                ) {
                  validateNestedConfig(value as any, `${path}.${key}`);
                }
              });
            }
          }
        };

        // Validate nested structures in extraction
        if (parsed.modification.extraction?.selectors) {
          Object.entries(parsed.modification.extraction.selectors).forEach(
            ([key, value]) => {
              if (
                value &&
                typeof value === "object" &&
                (value as any).type === "array"
              ) {
                validateNestedConfig(value, `extraction.selectors.${key}`);
              }
            }
          );
        }

        // Validate nested structures in jsonPath
        if (parsed.modification.jsonPath?.fieldPaths) {
          Object.entries(parsed.modification.jsonPath.fieldPaths).forEach(
            ([key, value]) => {
              if (
                value &&
                typeof value === "object" &&
                (value as any).type === "array"
              ) {
                validateNestedConfig(value, `jsonPath.fieldPaths.${key}`);
              }
            }
          );
        }

        // Validate the modified instructions
        try {
          validateScrapingInstructions(parsed.modification);
          refinementResponse = {
            ok: false,
            modification: parsed.modification as ScrapingInstructions,
            reason:
              parsed.reason || "Instructions modified based on test results",
          };
        } catch (validationError) {
          const errorMessage =
            validationError instanceof Error
              ? validationError.message
              : "Validation failed";
          console.error(
            `❌ Modified instructions validation failed: ${errorMessage}`
          );
          throw new Error(`Modified instructions are invalid: ${errorMessage}`);
        }
      } else {
        throw new Error(
          "Invalid response format: missing 'ok' or 'modification'"
        );
      }
    } catch (parseError) {
      console.error(`❌ Failed to parse agent response:`, parseError);
      console.error(`📄 Raw response text (${responseText.length} chars):`);
      console.error(responseText);
      console.error(`📄 Extracted JSON text (${jsonText.length} chars):`);
      console.error(jsonText);
      if (jsonText.length > 0) {
        // Try to show where the error might be
        const errorMessage =
          parseError instanceof Error ? parseError.message : String(parseError);
        console.error(`🔍 Parse error: ${errorMessage}`);
        // Show first and last 200 chars of JSON text for context
        if (jsonText.length > 400) {
          console.error(
            `📋 JSON preview (first 200 chars): ${jsonText.substring(
              0,
              200
            )}...`
          );
          console.error(
            `📋 JSON preview (last 200 chars): ...${jsonText.substring(
              jsonText.length - 200
            )}`
          );
        } else {
          console.error(`📋 Full JSON text: ${jsonText}`);
        }
      }
      throw new Error(
        `Failed to parse agent response: ${
          parseError instanceof Error ? parseError.message : String(parseError)
        }`
      );
    }

    // Add assistant response to history
    const finalHistory: ConversationMessage[] = [
      ...updatedHistory,
      { role: "assistant" as const, content: responseText },
    ];

    console.log(
      `✅ Refinement response: ${
        refinementResponse.ok ? "APPROVED" : "MODIFICATION REQUESTED"
      }`
    );
    if (refinementResponse.reason) {
      console.log(`   Reason: ${refinementResponse.reason}`);
    }

    return {
      response: refinementResponse,
      updatedHistory: finalHistory,
    };
  } catch (error) {
    console.error(
      `❌ Refinement failed:`,
      error instanceof Error ? error.message : error
    );
    throw error;
  }
}

/**
 * Initialize conversation history with system message
 */
export function initializeConversationHistory(): ConversationMessage[] {
  return [
    {
      role: "system",
      content: `You are an expert at analyzing and refining web scraping instructions. Your task is to review test results from executing scraping instructions and determine if they need to be modified.

IMPORTANT CAPABILITIES:
- The system supports UNLIMITED RECURSIVE NESTED ARRAYS - arrays within arrays within arrays at any depth
- For nested arrays in HTML: Use nested extraction configs with containerSelector for each array level
- For nested arrays in JSON: Use nested extraction configs with jsonPath for each array level
- The schema generation automatically handles advanced JSON Schema features (anyOf, allOf, oneOf, enum, constraints, nullable types)
- When fixing nested structures, ensure each array level has proper containerSelector (HTML) or jsonPath (JSON)

When test results show:
- Success: Data extracted correctly, pagination works (if configured) → Respond with {"ok": true}
- Failures: Errors in extraction, no data extracted, pagination not working → Respond with {"modification": {<updated selectors>}, "reason": "<explanation>"}

Pay special attention to:
- Field extraction statistics in debugInfo (selector matches, success rates)
- Pagination test results (if paginationTestResult shows failures, fix pagination configuration)
- Whether data was extracted successfully (check extractedDataSample)
- Selector effectiveness (check debugInfo for match counts)

IMPORTANT: You only need to modify SELECTORS. Do NOT include a schema field - it will be generated automatically.
Always return valid JSON only. The modification must have the same structure as the selectors (extraction/jsonPath, etc.) but with updated selector values.`,
    },
  ];
}
