import { type ScrapingInstructions, type TestResults } from "../types";
import {
  scrapeWithInstructions,
  type PaginationOptions,
} from "./scraper.service";
import {
  getScrapingInstructions,
  saveTestResult,
  updateScrapingInstructions,
} from "./storage.service";
import { logPaginationDebugInfo } from "./debug.service";
import { generateSchemaFromData } from "../utils/schema-generator";
import { PaginationTester } from "./pagination-test.service";
import { PaginationAnalyzer } from "./pagination-analyzer.service";

/**
 * Test scraping instructions by executing them
 */
export async function testInstructions(id: string): Promise<TestResults> {
  console.log(`\n=== TESTING INSTRUCTIONS ===`);
  console.log(`ID: ${id}`);

  try {
    const metadata = await getScrapingInstructions(id);
    if (!metadata) {
      return {
        success: false,
        errors: [`Instructions not found for ID: ${id}`],
      };
    }

    let instructions = metadata.instructions;

    // Capture actual HTML response for debugging (if HTML/XML)
    let actualHtmlResponse: string | undefined;
    let containerHtmlSamples: string[] | undefined;
    if (
      instructions.responseType === "html" ||
      instructions.responseType === "xml"
    ) {
      try {
        // Build the request URL and headers
        const { url, body, headers, queryParams } = buildRequestParams(
          instructions,
          {}
        );
        const requestHeaders: Record<string, string> = {
          ...instructions.headers?.static,
          ...instructions.headers?.dynamic,
          ...headers,
        };
        const requestOptions: RequestInit = {
          method: instructions.method,
          headers: requestHeaders,
        };
        if (
          body &&
          (instructions.method === "POST" ||
            instructions.method === "PUT" ||
            instructions.method === "PATCH")
        ) {
          requestOptions.body = JSON.stringify(body);
          if (!requestHeaders["Content-Type"]) {
            requestHeaders["Content-Type"] = "application/json";
          }
        }
        const response = await fetch(url, requestOptions);
        if (response.ok) {
          actualHtmlResponse = await response.text();
          console.log(
            `📄 Captured HTML response (${actualHtmlResponse.length} chars)`
          );

          // Extract container HTML samples if we have a containerSelector
          if (
            instructions.outputType === "array" &&
            instructions.extraction?.containerSelector
          ) {
            try {
              const cheerio = await import("cheerio");
              const $ = cheerio.load(actualHtmlResponse);
              const containerSelector =
                instructions.extraction.containerSelector
                  .replace(/::text\b/g, "")
                  .replace(/::html\b/g, "")
                  .replace(/::attr\([^)]*\)/g, "")
                  .trim();
              const containers = $(containerSelector);

              containerHtmlSamples = [];
              const maxSamples = 3;
              const maxLengthPerSample = 2000;

              for (
                let i = 0;
                i < Math.min(containers.length, maxSamples);
                i++
              ) {
                const containerHtml = $(containers[i]).html() || "";
                containerHtmlSamples.push(
                  containerHtml.substring(0, maxLengthPerSample)
                );
              }

              console.log(
                `📦 Extracted ${containerHtmlSamples.length} container HTML samples`
              );
            } catch (error) {
              console.log(
                `⚠️  Failed to extract container HTML: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          }
        }
      } catch (error) {
        console.log(
          `⚠️  Failed to capture HTML response: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    // Execute scraping
    let scrapeResult;
    try {
      scrapeResult = await scrapeWithInstructions(id, {});
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.log(`❌ Scraping execution failed: ${errorMessage}`);
      return {
        success: false,
        errors: [`Execution failed: ${errorMessage}`],
        debugInfo: {
          executionError: errorMessage,
          actualHtmlResponse: actualHtmlResponse
            ? actualHtmlResponse.substring(0, 5000)
            : undefined,
        },
      };
    }

    const extractedData = scrapeResult.data;
    console.log(
      `✅ Scraping executed. Extracted ${
        Array.isArray(extractedData) ? extractedData.length : 1
      } item(s)`
    );

    // Generate schema from extracted data and update instructions if schema doesn't exist
    if (
      !instructions.schema &&
      extractedData !== null &&
      extractedData !== undefined
    ) {
      const schema = generateSchemaFromData(extractedData);
      const updatedInstructions: ScrapingInstructions = {
        ...instructions,
        schema,
      };
      // Update instructions in database
      await updateScrapingInstructions(id, updatedInstructions);
      instructions = updatedInstructions;
      console.log("   ✅ Schema generated from extracted data");
    }

    // Basic validation - just check if we got data
    const hasData = extractedData !== null && extractedData !== undefined;
    const hasItems = Array.isArray(extractedData)
      ? extractedData.length > 0
      : true;
    const success = hasData && hasItems;

    // Prepare sample data (limit size for debugging)
    let dataSample = extractedData;
    if (Array.isArray(extractedData) && extractedData.length > 0) {
      dataSample = extractedData.slice(0, 3); // First 3 items
    }

    // Test pagination if configured
    let paginationTestResult;
    if (instructions.pagination) {
      try {
        console.log("\n=== TESTING PAGINATION ===");
        const tester = new PaginationTester();
        const { url, body, headers } = buildRequestParams(instructions, {});

        // Create a candidate from the pagination config
        const candidate = {
          type: instructions.pagination.type,
          location: instructions.pagination.location,
          paramName: instructions.pagination.location.split(".").pop(),
          pattern: instructions.pagination.placeholder.includes("page")
            ? ("page" as const)
            : instructions.pagination.placeholder.includes("offset")
            ? ("offset" as const)
            : ("cursor" as const),
          confidence: 0.8,
          initialValue: instructions.pagination.initialValue,
        };

        // Test pagination pattern
        const baseUrl = url.split("?")[0];
        if (!baseUrl) {
          paginationTestResult = {
            tested: true,
            passed: false,
            error: "Could not determine base URL",
          };
        } else {
          const testResult = await tester.testPaginationPattern(
            candidate,
            baseUrl,
            instructions.method,
            headers,
            body
          );

          paginationTestResult = {
            tested: true,
            passed: testResult.passed,
            error: testResult.error,
          };

          // Test first page difference
          if (testResult.passed) {
            const firstPageTest = await tester.testFirstPageDifference(
              candidate,
              baseUrl,
              instructions.method,
              headers,
              body
            );

            if (firstPageTest.different) {
              console.log(
                `   ℹ️  First page handled differently (prefer: ${firstPageTest.preferredApproach})`
              );
            }
          }

          console.log(
            `   ${testResult.passed ? "✅" : "❌"} Pagination test: ${
              testResult.passed ? "PASSED" : "FAILED"
            }`
          );
          if (testResult.error) {
            console.log(`   Error: ${testResult.error}`);
          }
        }
      } catch (error) {
        console.warn("   ⚠️  Pagination test failed:", error);
        paginationTestResult = {
          tested: true,
          passed: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const testResults: TestResults = {
      success,
      extractedData: dataSample,
      errors: !success ? ["No data extracted or empty result"] : undefined,
      paginationTestResult,
      debugInfo: {
        totalItems: Array.isArray(extractedData) ? extractedData.length : 1,
        outputType: instructions.outputType,
        responseType: instructions.responseType,
        hasPagination: !!instructions.pagination,
        actualHtmlResponse: actualHtmlResponse
          ? actualHtmlResponse.substring(0, 10000)
          : undefined, // First 10KB for agent analysis
        htmlLength: actualHtmlResponse?.length,
        containerHtmlSamples: containerHtmlSamples,
      },
    };

    if (testResults.success) {
      console.log(`✅ Test passed`);
    } else {
      console.log(`❌ Test failed`);
      if (testResults.errors && testResults.errors.length > 0) {
        console.log(`   Errors: ${testResults.errors.join(", ")}`);
      }
    }

    // Save test result to database
    try {
      await saveTestResult(id, testResults);
    } catch (error) {
      console.error("⚠️  Failed to save test result to database:", error);
      // Don't throw - we still want to return the result even if saving fails
    }

    return testResults;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ Test failed with error: ${errorMessage}`);
    return {
      success: false,
      errors: [`Test error: ${errorMessage}`],
      debugInfo: {
        testError: errorMessage,
      },
    };
  }
}

/**
 * Build request parameters (similar to applyPagination in scraper.service)
 */
function buildRequestParams(
  instructions: ScrapingInstructions,
  paginationOptions: { page?: number; limit?: number; offset?: number } = {}
): {
  url: string;
  body?: any;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
} {
  const { pagination } = instructions;
  if (!pagination) {
    return {
      url: instructions.baseUrl,
      headers: {},
      queryParams: {},
    };
  }

  let url = instructions.baseUrl;
  let body: any = undefined;
  let headers: Record<string, string> = {};
  let queryParams: Record<string, string> = {};

  // Determine pagination value based on type
  let paginationValue: string | number | undefined;
  if (pagination.type === "query" || pagination.type === "body") {
    if (paginationOptions.page !== undefined) {
      paginationValue = paginationOptions.page;
    } else if (paginationOptions.offset !== undefined) {
      paginationValue = paginationOptions.offset;
    } else if (pagination.initialValue !== undefined) {
      paginationValue = pagination.initialValue;
    } else {
      paginationValue = 1;
    }
  }

  // Apply pagination based on type
  if (pagination.type === "query") {
    const parts = pagination.location.split(".");
    const location = parts[0];
    const param = parts[1];
    if (location === "query" && param) {
      queryParams[param] = String(paginationValue);
    }
  } else if (pagination.type === "body") {
    body = { ...instructions.body?.structure };
    const parts = pagination.location.split(".");
    const location = parts[0];
    const path = parts.slice(1);
    if (location === "body" && path.length > 0) {
      let current: any = body;
      for (let i = 0; i < path.length - 1; i++) {
        const pathKey = path[i];
        if (pathKey) {
          if (!current[pathKey]) {
            current[pathKey] = {};
          }
          current = current[pathKey];
        }
      }
      const lastKey = path[path.length - 1];
      if (lastKey) {
        current[lastKey] = paginationValue;
      }
    }
  } else if (pagination.type === "header") {
    const parts = pagination.location.split(".");
    const location = parts[0];
    const headerName = parts[1];
    if (location === "header" && headerName) {
      headers[headerName] = String(paginationValue);
    }
  }

  // Replace placeholders in query params
  const queryParamsData =
    instructions.queryParams?.structure || instructions.queryParams;
  if (queryParamsData) {
    Object.entries(queryParamsData).forEach(([key, value]) => {
      if (typeof value === "string" && value.includes("{{")) {
        let replaced = value;
        if (pagination.placeholder && paginationValue !== undefined) {
          replaced = replaced.replace(
            pagination.placeholder,
            String(paginationValue)
          );
        }
        queryParams[key] = replaced;
      } else {
        queryParams[key] = String(value);
      }
    });
  }

  // Build URL with query params
  if (Object.keys(queryParams).length > 0) {
    const urlObj = new URL(url);
    Object.entries(queryParams).forEach(([key, value]) => {
      urlObj.searchParams.set(key, value);
    });
    url = urlObj.toString();
  }

  return { url, body, headers, queryParams };
}
