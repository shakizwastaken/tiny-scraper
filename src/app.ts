import express from "express";
import puppeteer, { Browser, Page, HTTPRequest, HTTPResponse } from "puppeteer";

const app = express();

app.use(express.json());

interface RequestMetadata {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
}

interface InterceptedRequest {
  request: HTTPRequest;
  response?: HTTPResponse;
  responseBody?: string;
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

        matchingRequests.push({
          url: requestUrl,
          method: request.method(),
          headers: requestHeaders,
          postData: request.postData() || undefined,
          responseStatus: response?.status(),
          responseHeaders:
            Object.keys(responseHeaders).length > 0
              ? responseHeaders
              : undefined,
          responseBody: responseBody,
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
