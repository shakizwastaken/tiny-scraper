import { type Request, type Response } from "express";
import { type ScrapingInstructions } from "../types";
import { validateScrapeRequest } from "../validators/request.validator";
import { BrowserService } from "../services/browser.service";
import { generateScrapingInstructions } from "../services/openai.service";
import {
  extractContextAroundSearchTerm,
  shouldUseFullPassthrough,
} from "../utils/context-extractor";
import { openai } from "../config";
import { FULL_RESPONSE_THRESHOLD } from "../config";
import { selectBestRequest } from "../services/request-selector.service";
import type { InterceptedRequest } from "../types/scraping";
import {
  saveScrapingInstructions,
  updateScrapingInstructions,
} from "../services/storage.service";
import { testInstructions } from "../services/instruction-test.service";
import {
  refineInstructions,
  initializeConversationHistory,
  type ConversationMessage,
} from "../services/instruction-refinement.service";

// Mutex to prevent concurrent refinement executions
let refinementInProgress = false;

/**
 * Scrape route handler
 */
export async function scrapeHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { url, search, expectedOutputType, customPrompt } = req.query;

  console.log("\n=== SCRAPING REQUEST STARTED ===");
  console.log("URL:", url);
  console.log("Search term:", search);
  console.log("Expected output type:", expectedOutputType || "(not specified)");
  console.log(
    "Custom prompt:",
    customPrompt ? `${customPrompt.length} chars` : "(not provided)"
  );
  console.log("Timestamp:", new Date().toISOString());

  // Validate query parameters
  let validatedParams: {
    url: string;
    search: string;
    expectedOutputType?: "array" | "object";
    customPrompt?: string;
  };
  try {
    validatedParams = validateScrapeRequest(
      url,
      search,
      expectedOutputType,
      customPrompt
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Validation failed";
    console.log(`❌ Validation failed: ${errorMessage}`);
    res.status(400).json({ error: errorMessage });
    return;
  }

  const {
    url: validUrl,
    search: validSearch,
    expectedOutputType: validExpectedOutputType,
    customPrompt: validCustomPrompt,
  } = validatedParams;
  console.log("✅ Parameters validated");

  const browserService = new BrowserService();
  let scrapingInstructions: ScrapingInstructions | null = null;
  let gptError: string | undefined;
  let id: string | undefined;

  try {
    // Launch browser
    await browserService.launchBrowser();

    // Setup page with request interception
    const { page, interceptedRequests } =
      await browserService.setupPageWithInterception();

    // Navigate to URL
    await browserService.navigateToUrl(page, validUrl);

    console.log("\n=== INTERCEPTION SUMMARY ===");
    console.log(
      `Total intercepted requests stored: ${interceptedRequests.length}`
    );

    // Find all requests where response body contains the search term (case-insensitive)
    console.log("\n[6/6] Filtering requests by search term...");
    const searchLower = validSearch.toLowerCase();
    console.log(`   Search term (lowercase): "${searchLower}"`);

    const matchingRequests: InterceptedRequest[] = [];

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
        matchingRequests.push(intercepted);
        console.log(
          `   ✅ MATCH FOUND! (Total matches: ${matchingRequests.length})`
        );
      }
    }

    if (matchingRequests.length === 0) {
      console.log("   ❌ No matching requests found");
    } else {
      // Select best request if multiple matches
      let selectedRequest: InterceptedRequest;
      if (matchingRequests.length > 1) {
        console.log(
          `\n=== SELECTING BEST REQUEST FROM ${matchingRequests.length} MATCHES ===`
        );
        const selectionResult = await selectBestRequest(
          matchingRequests,
          validSearch
        );
        const candidate = matchingRequests[selectionResult.selectedIndex];
        if (!candidate) {
          throw new Error("Selected request index is invalid");
        }
        selectedRequest = candidate;
        console.log(
          `✅ Selected request #${selectionResult.selectedIndex + 1}: ${
            selectionResult.reasoning
          }`
        );
      } else {
        const candidate = matchingRequests[0];
        if (!candidate) {
          throw new Error("No matching request available");
        }
        selectedRequest = candidate;
        console.log(`✅ Using single match`);
      }

      const { request, response, responseBody } = selectedRequest;
      const requestUrl = request.url();

      console.log(
        `\n   Processing selected request: ${request.method()} ${requestUrl}`
      );

      const requestHeaders: Record<string, string> = {};
      const reqHeaders = request.headers();
      Object.entries(reqHeaders).forEach(([key, value]) => {
        requestHeaders[key] = value;
      });

      const method = request.method();
      const postData = request.postData() || undefined;

      // Get content type from response headers
      const contentType = response
        ? response.headers()["content-type"] || undefined
        : undefined;

      // Check if we should use full response passthrough
      const useFullResponse = shouldUseFullPassthrough(
        responseBody!,
        FULL_RESPONSE_THRESHOLD
      );

      let context: string;
      if (useFullResponse) {
        console.log(
          `   📄 Using full response passthrough (${
            responseBody!.length
          } chars < ${FULL_RESPONSE_THRESHOLD})`
        );
        context = responseBody!;
      } else {
        console.log(
          `   ✂️  Extracting context (${
            responseBody!.length
          } chars >= ${FULL_RESPONSE_THRESHOLD})`
        );
        context = extractContextAroundSearchTerm(
          responseBody!,
          validSearch,
          1000000 // Max tokens available
        );
      }

      // Generate scraping instructions with GPT
      try {
        const instructions = await generateScrapingInstructions(
          openai,
          requestUrl,
          method,
          requestHeaders,
          postData,
          context,
          contentType,
          responseBody!,
          useFullResponse,
          validExpectedOutputType,
          validCustomPrompt
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
    }

    console.log("\n=== REQUEST COMPLETED SUCCESSFULLY ===\n");

    // Return only the instructions (or error if failed)
    if (gptError) {
      res.status(500).json({
        error: "Failed to generate scraping instructions",
        message: gptError,
      });
      return;
    }

    if (!scrapingInstructions) {
      res.status(404).json({
        error: "No matching request found or failed to generate instructions",
      });
      return;
    }

    // Save initial instructions to storage (will be updated during refinement)
    id = await saveScrapingInstructions(
      scrapingInstructions,
      validUrl,
      validSearch
    );

    res.json({ id });

    // Note: Testing and refinement happens after response is sent
    // to avoid blocking the HTTP response
    // This runs in the background after browser cleanup
  } catch (error) {
    // Error handling is done by the error handler middleware
    throw error;
  } finally {
    // Clean up browser instance
    console.log("\n=== CLEANUP ===");
    await browserService.closeBrowser();
    console.log("✅ Browser closed");

    // After browser is fully closed, run testing and refinement loop
    if (scrapingInstructions && !gptError && id) {
      try {
        await runTestingAndRefinementLoop(
          id,
          scrapingInstructions,
          validUrl,
          validSearch
        );
      } catch (error) {
        console.error(
          "\n❌ Testing/refinement loop failed:",
          error instanceof Error ? error.message : error
        );
        // Don't throw - this is background processing
      }
    }

    console.log("=== END ===\n");
  }
}

/**
 * Run testing and refinement loop
 */
async function runTestingAndRefinementLoop(
  id: string,
  initialInstructions: ScrapingInstructions,
  originalUrl: string,
  originalSearch: string
): Promise<void> {
  // Prevent concurrent executions
  if (refinementInProgress) {
    console.log("\n⚠️  Refinement already in progress, skipping...");
    return;
  }

  refinementInProgress = true;

  try {
    console.log("\n=== TESTING AND REFINEMENT LOOP ===");

    let currentInstructions = initialInstructions;
    let conversationHistory: ConversationMessage[] =
      initializeConversationHistory();
    const maxIterations = 10;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      console.log(`\n--- Iteration ${iteration}/${maxIterations} ---`);

      // Update instructions in storage before testing
      await updateScrapingInstructions(id, currentInstructions);

      // Test the current instructions
      const testResults = await testInstructions(id);

      console.log(`\nTest Results:`);
      console.log(`  Success: ${testResults.success}`);
      if (testResults.errors && testResults.errors.length > 0) {
        console.log(`  Errors: ${testResults.errors.join(", ")}`);
      }

      // Send to refinement service
      try {
        const { response, updatedHistory } = await refineInstructions(
          currentInstructions,
          testResults,
          conversationHistory
        );

        conversationHistory = updatedHistory;

        if (response.ok) {
          console.log(
            `\n✅ Instructions approved by agent after ${iteration} iteration(s)`
          );
          // Final update with approved instructions
          await updateScrapingInstructions(id, currentInstructions);
          return;
        }

        if (response.modification) {
          console.log(`\n📝 Agent requested modification:`);
          if (response.reason) {
            console.log(`   Reason: ${response.reason}`);
          }
          currentInstructions = response.modification;
          console.log(`   Updated instructions, will test again...`);
          // Continue to next iteration
        } else {
          console.log(`\n⚠️  Agent response missing modification field`);
          // This shouldn't happen, but if it does, we'll continue
        }
      } catch (error) {
        console.error(
          `\n❌ Refinement failed on iteration ${iteration}:`,
          error instanceof Error ? error.message : error
        );
        // Continue to next iteration or break based on error type
        if (iteration === maxIterations) {
          throw new Error(
            `Refinement failed after ${maxIterations} iterations: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }

    // If we reach here, max iterations reached
    console.log(
      `\n⚠️  Maximum iterations (${maxIterations}) reached. Using last tested instructions.`
    );
    await updateScrapingInstructions(id, currentInstructions);
    throw new Error(
      `Testing and refinement did not complete successfully after ${maxIterations} iterations`
    );
  } finally {
    refinementInProgress = false;
  }
}
