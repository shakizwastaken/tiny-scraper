import { type Request, type Response } from "express";
import { type ScrapingInstructions } from "../types";
import { validateScrapeRequest } from "../validators/request.validator";
import { BrowserService } from "../services/browser.service";
import { generateScrapingInstructions } from "../services/openai.service";
import { extractContextAroundSearchTerm } from "../utils/context-extractor";
import { openai } from "../config";

/**
 * Scrape route handler
 */
export async function scrapeHandler(
  req: Request,
  res: Response
): Promise<void> {
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

    // Find first request where response body contains the search term (case-insensitive)
    console.log("\n[6/6] Filtering requests by search term...");
    const searchLower = validSearch.toLowerCase();
    console.log(`   Search term (lowercase): "${searchLower}"`);

    let scrapingInstructions: ScrapingInstructions | null = null;
    let gptError: string | undefined;

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
        console.log(`   ✅ MATCH FOUND! Processing with GPT...`);

        const requestHeaders: Record<string, string> = {};
        const reqHeaders = request.headers();
        Object.entries(reqHeaders).forEach(([key, value]) => {
          requestHeaders[key] = value;
        });

        const method = request.method();
        const postData = request.postData() || undefined;

        // Generate scraping instructions with GPT
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

        // Break after processing first match
        break;
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

    res.json(scrapingInstructions);
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
