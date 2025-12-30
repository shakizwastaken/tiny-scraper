import {
  type ScrapingInstructions,
  type TestResults,
  type RefinementResponse,
} from "../types";
import { openai, OPENAI_REFINEMENT_MODEL, OPENAI_MAX_TOKENS } from "../config";
import { validateScrapingInstructions } from "../validators/scraping.validator";

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

  // Build the user message with test results and current instructions
  const testResultsSummary = {
    success: testResults.success,
    errors: testResults.errors || [],
    schemaValidationErrors: testResults.schemaValidationErrors || [],
    requiredFieldsMissing: testResults.requiredFieldsMissing || [],
    extractedDataSample: testResults.extractedData,
    debugInfo: testResults.debugInfo,
    paginationTestResult: testResults.paginationTestResult,
  };

  // Include HTML response if available (for debugging selector issues)
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
  }

  const userMessage = `I have tested the scraping instructions and here are the results:

TEST RESULTS:
${JSON.stringify(testResultsSummary, null, 2)}${htmlContext}

CURRENT INSTRUCTIONS:
${JSON.stringify(instructions, null, 2)}

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

Please analyze the test results and the current instructions. 

If the instructions work correctly (test passed, all required fields present, no errors), respond with:
{"ok": true}

If the instructions need modification, respond with:
{"ok": false, "modification": {<complete updated instructions JSON>}, "reason": "<brief explanation of what was fixed>"}

IMPORTANT:
- Return ONLY valid JSON, no markdown, no code blocks, no explanations outside the JSON
- The "modification" must be a complete, valid ScrapingInstructions object
- If modifying, ensure all required fields are included
- Keep the same structure and format as the original instructions`;

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
    });

    const responseText = completion.choices[0]?.message?.content?.trim() || "";
    console.log(`✅ Agent response received (${responseText.length} chars)`);

    // Try to extract JSON from response (handle markdown code blocks if present)
    let jsonText = responseText;
    const jsonMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    if (jsonMatch) jsonText = jsonMatch[1] || "";

    // Parse the response
    let refinementResponse: RefinementResponse;
    try {
      const parsed = JSON.parse(jsonText);

      if (parsed.ok === true) {
        refinementResponse = { ok: true };
      } else if (parsed.modification) {
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

When test results show:
- Success: All data extracted correctly, schema validation passes, all required fields present, pagination works (if configured) → Respond with {"ok": true}
- Failures: Errors in extraction, schema validation failures, missing required fields, pagination not working → Respond with {"modification": {<updated instructions>}, "reason": "<explanation>"}

Pay special attention to:
- Field extraction statistics in debugInfo (selector matches, success rates)
- Pagination test results (if paginationTestResult shows failures, fix pagination configuration)
- Required fields that are missing (ensure selectors are correct)
- Schema validation errors (fix field types or selectors)

Always return valid JSON only. The modification must be a complete, valid ScrapingInstructions object that fixes the issues found in the test results.`,
    },
  ];
}
