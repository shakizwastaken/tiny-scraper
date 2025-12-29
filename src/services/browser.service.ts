import puppeteer, { Browser, Page, HTTPRequest, HTTPResponse } from "puppeteer";
import { type InterceptedRequest } from "../types";
import {
  BROWSER_ARGS,
  NAVIGATION_TIMEOUT,
  RESPONSE_WAIT_TIME,
} from "../config";

/**
 * Browser service for managing Puppeteer browser instances and request interception
 */
export class BrowserService {
  private browser: Browser | null = null;

  /**
   * Launch a new browser instance
   */
  async launchBrowser(): Promise<Browser> {
    console.log("\n[1/6] Launching browser...");
    this.browser = await puppeteer.launch({
      args: BROWSER_ARGS,
      headless: false,
    });
    console.log("✅ Browser launched successfully");
    return this.browser;
  }

  /**
   * Create a new page and set up request/response interception
   */
  async setupPageWithInterception(): Promise<{
    page: Page;
    interceptedRequests: InterceptedRequest[];
  }> {
    if (!this.browser) {
      throw new Error("Browser not launched. Call launchBrowser() first.");
    }

    console.log("\n[2/6] Creating new page...");
    const page = await this.browser.newPage();
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

    return { page, interceptedRequests };
  }

  /**
   * Navigate to URL and wait for network to be idle
   */
  async navigateToUrl(page: Page, url: string): Promise<void> {
    console.log("\n[4/6] Navigating to URL...");
    console.log(`   Target: ${url}`);
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: NAVIGATION_TIMEOUT,
    });
    console.log("✅ Navigation completed");

    // Wait a bit more to ensure all responses are captured
    console.log("\n[5/6] Waiting for all responses to be processed...");
    await new Promise((resolve) => setTimeout(resolve, RESPONSE_WAIT_TIME));
    console.log("✅ Wait complete");
  }

  /**
   * Close the browser instance
   */
  async closeBrowser(): Promise<void> {
    if (this.browser) {
      console.log("Closing browser...");
      await this.browser.close();
      console.log("✅ Browser closed");
      this.browser = null;
    } else {
      console.log("⚠️  No browser instance to close");
    }
  }

  /**
   * Get the current browser instance
   */
  getBrowser(): Browser | null {
    return this.browser;
  }
}
