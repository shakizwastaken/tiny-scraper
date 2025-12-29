import { type Request, type Response } from "express";
import { type RequestMetadata, type ScrapingInstructions } from "../types";
import { validateScrapeRequest } from "../validators/request.validator";
import { BrowserService } from "../services/browser.service";
import { generateScrapingInstructions } from "../services/openai.service";
import { extractContextAroundSearchTerm } from "../utils/context-extractor";
import { openai } from "../config";

/**
 * Scrape route handler
 */
export async function scrapeHandler(req: Request, res: Response): Promise<void> {
  const { url, search } = req.query;

  console.log("\n=== SCRAPING REQUEST STARTED ===");
  console.log("URL:", url);
  console.log("Search term:", search);
  console.log("Timestamp:", new Date().toISOString());

  // Validate query parameters
  let validatedParams: { url: string; search: string };
  try {
    validatedParams = validateScrapeRequest(url, search);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Validation failed";
    console.log(`❌ Validation failed: ${errorMessage}`);
    res.status(400).json({ error: errorMessage });
    return;
  }

  const { url: validUrl, search: validSearch } = validatedParams;
  console.log("✅ Parameters validated");

  const browserService = new BrowserService();

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

    // Filter requests where response body contains the search term (case-insensitive)
    console.log("\n[6/6] Filtering requests by search term...");
    const searchLower = validSearch.toLowerCase();
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
              validSearch,
              1000000 // Max tokens available
            );

            // Get content type from response headers
            const contentType = response
              ? response.headers()["content-type"] || undefined
              : undefined;

            // Generate scraping instructions
            const instructions = await generateScrapingInstructions(
              openai,
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
      url: validUrl,
      search: validSearch,
      matches: matchingRequests.length,
      requests: matchingRequests,
    });
  } catch (error) {
    // Error handling is done by the error handler middleware
    throw error;
  } finally {
    // Clean up browser instance
    console.log("\n=== CLEANUP ===");
    await browserService.closeBrowser();
    console.log("=== END ===\n");
  }
}

