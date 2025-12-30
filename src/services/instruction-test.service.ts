import { type ScrapingInstructions, type TestResults } from "../types";
import { scrapeWithInstructions } from "./scraper.service";
import { getScrapingInstructions } from "./storage.service";

/**
 * Validate extracted data against JSON schema
 */
function validateAgainstSchema(
  data: any,
  schema: ScrapingInstructions["schema"]
): { valid: boolean; errors: string[]; missingFields: string[] } {
  const errors: string[] = [];
  const missingFields: string[] = [];

  // Helper to validate a value against a schema property
  const validateProperty = (
    value: any,
    propSchema: any,
    fieldName: string
  ): void => {
    if (propSchema.required && propSchema.required.includes(fieldName)) {
      if (value === null || value === undefined || value === "") {
        missingFields.push(fieldName);
      }
    }

    if (value === null || value === undefined) {
      return; // Null values are allowed unless required
    }

    if (propSchema.type) {
      const expectedType = propSchema.type;
      const actualType = Array.isArray(value)
        ? "array"
        : typeof value === "object" && value !== null
          ? "object"
          : typeof value;

      if (expectedType === "array" && !Array.isArray(value)) {
        errors.push(
          `Field "${fieldName}": expected array, got ${actualType}`
        );
      } else if (expectedType === "object" && (actualType !== "object" || Array.isArray(value))) {
        errors.push(
          `Field "${fieldName}": expected object, got ${actualType}`
        );
      } else if (
        !["array", "object"].includes(expectedType) &&
        actualType !== expectedType
      ) {
        errors.push(
          `Field "${fieldName}": expected ${expectedType}, got ${actualType}`
        );
      }
    }

    // Validate format for strings
    if (propSchema.format && typeof value === "string") {
      if (propSchema.format === "uri" && !value.startsWith("http")) {
        errors.push(`Field "${fieldName}": expected URI format`);
      }
      // Add more format validations as needed
    }
  };

  if (schema.type === "array") {
    if (!Array.isArray(data)) {
      errors.push("Expected array output, but got non-array");
      return { valid: false, errors, missingFields };
    }

    if (data.length === 0) {
      errors.push("Array is empty - no data extracted");
      return { valid: false, errors, missingFields };
    }

    // Validate first item (sample)
    if (schema.items && schema.items.properties) {
      const firstItem = data[0];
      Object.entries(schema.items.properties).forEach(([fieldName, propSchema]) => {
        validateProperty(firstItem[fieldName], propSchema, fieldName);
      });
    }
  } else if (schema.type === "object") {
    if (Array.isArray(data) || typeof data !== "object" || data === null) {
      errors.push("Expected object output, but got non-object");
      return { valid: false, errors, missingFields };
    }

    if (schema.properties) {
      Object.entries(schema.properties).forEach(([fieldName, propSchema]) => {
        validateProperty(data[fieldName], propSchema, fieldName);
      });
    }
  }

  return {
    valid: errors.length === 0 && missingFields.length === 0,
    errors,
    missingFields,
  };
}

/**
 * Test scraping instructions by executing them
 */
export async function testInstructions(
  id: string
): Promise<TestResults> {
  console.log(`\n=== TESTING INSTRUCTIONS ===`);
  console.log(`ID: ${id}`);

  try {
    const metadata = getScrapingInstructions(id);
    if (!metadata) {
      return {
        success: false,
        errors: [`Instructions not found for ID: ${id}`],
      };
    }

    const { instructions } = metadata;

    // Capture actual HTML response for debugging (if HTML/XML)
    let actualHtmlResponse: string | undefined;
    if (instructions.responseType === "html" || instructions.responseType === "xml") {
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

    // Validate against schema
    const validation = validateAgainstSchema(
      extractedData,
      instructions.schema
    );

    // Prepare sample data (limit size for debugging)
    let dataSample = extractedData;
    if (Array.isArray(extractedData) && extractedData.length > 0) {
      dataSample = extractedData.slice(0, 3); // First 3 items
    }

    const testResults: TestResults = {
      success: validation.valid && extractedData !== null && extractedData !== undefined,
      extractedData: dataSample,
      errors: validation.errors.length > 0 ? validation.errors : undefined,
      schemaValidationErrors:
        validation.errors.length > 0 ? validation.errors : undefined,
      requiredFieldsMissing:
        validation.missingFields.length > 0
          ? validation.missingFields
          : undefined,
      debugInfo: {
        totalItems: Array.isArray(extractedData)
          ? extractedData.length
          : 1,
        outputType: instructions.outputType,
        responseType: instructions.responseType,
        hasPagination: !!instructions.pagination,
        actualHtmlResponse: actualHtmlResponse
          ? actualHtmlResponse.substring(0, 10000)
          : undefined, // First 10KB for agent analysis
        htmlLength: actualHtmlResponse?.length,
      },
    };

    if (testResults.success) {
      console.log(`✅ Test passed`);
    } else {
      console.log(`❌ Test failed`);
      if (testResults.errors && testResults.errors.length > 0) {
        console.log(`   Errors: ${testResults.errors.join(", ")}`);
      }
      if (testResults.requiredFieldsMissing && testResults.requiredFieldsMissing.length > 0) {
        console.log(
          `   Missing fields: ${testResults.requiredFieldsMissing.join(", ")}`
        );
      }
    }

    return testResults;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
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

