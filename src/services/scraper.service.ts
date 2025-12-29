import { JSONPath } from "jsonpath-plus";
import * as cheerio from "cheerio";
import { type ScrapingInstructions } from "../types";
import {
  getScrapingInstructions,
  type ScrapingInstructionMetadata,
} from "./storage.service";

export interface PaginationOptions {
  page?: number;
  limit?: number;
  offset?: number;
  [key: string]: number | undefined;
}

export interface ScrapeResult {
  data: any;
  pagination?: {
    page?: number;
    limit?: number;
    offset?: number;
    hasMore?: boolean;
  };
}

/**
 * Apply pagination to instructions based on pagination options
 */
function applyPagination(
  instructions: ScrapingInstructions,
  options: PaginationOptions
): {
  url: string;
  body?: any;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
} {
  const { pagination } = instructions;
  if (!pagination) {
    return { url: instructions.baseUrl };
  }

  let url = instructions.baseUrl;
  let body: any = undefined;
  let headers: Record<string, string> = {};
  let queryParams: Record<string, string> = {};

  // Determine pagination value based on type
  let paginationValue: string | number | undefined;
  if (pagination.type === "query" || pagination.type === "body") {
    if (options.page !== undefined) {
      paginationValue = options.page;
    } else if (options.offset !== undefined) {
      paginationValue = options.offset;
    } else if (pagination.initialValue !== undefined) {
      paginationValue = pagination.initialValue;
    } else {
      paginationValue = 1; // Default to page 1
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
  // Handle both structure format and plain object format
  const queryParamsData =
    instructions.queryParams?.structure || instructions.queryParams;
  if (queryParamsData) {
    Object.entries(queryParamsData).forEach(([key, value]) => {
      if (typeof value === "string" && value.includes("{{")) {
        // Replace placeholders
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

  // Replace placeholders in body
  if (instructions.body?.structure) {
    body = JSON.parse(JSON.stringify(instructions.body.structure));
    const replacePlaceholders = (obj: any): any => {
      if (typeof obj === "string" && obj.includes("{{")) {
        if (pagination.placeholder && paginationValue !== undefined) {
          return obj.replace(pagination.placeholder, String(paginationValue));
        }
        return obj;
      }
      if (Array.isArray(obj)) {
        return obj.map(replacePlaceholders);
      }
      if (obj && typeof obj === "object") {
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
          result[key] = replacePlaceholders(value);
        }
        return result;
      }
      return obj;
    };
    body = replacePlaceholders(body);
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

/**
 * Make HTTP request based on instructions
 */
async function makeRequest(
  instructions: ScrapingInstructions,
  paginationOptions: PaginationOptions
): Promise<string> {
  const { url, body, headers, queryParams } = applyPagination(
    instructions,
    paginationOptions
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

  console.log(`Making ${instructions.method} request to: ${url}`);
  if (body) {
    console.log("Request body:", JSON.stringify(body, null, 2));
  }
  if (Object.keys(requestHeaders).length > 0) {
    console.log("Request headers:", requestHeaders);
  }

  const response = await fetch(url, requestOptions);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText} - ${url}`);
  }

  const responseBody = await response.text();
  return responseBody;
}

/**
 * Extract data from JSON response
 */
function extractFromJSON(
  body: string,
  instructions: ScrapingInstructions
): any {
  const json = JSON.parse(body);
  const { jsonPath } = instructions;

  if (!jsonPath) {
    throw new Error("Missing jsonPath in instructions for JSON response");
  }

  // Get root data
  let rootData = json;
  if (jsonPath.rootPath) {
    const rootResults = JSONPath({ path: jsonPath.rootPath, json });
    if (rootResults.length > 0) {
      rootData = rootResults[0];
    }
  }

  // Extract fields
  const result: Record<string, any> = {};
  Object.entries(jsonPath.fieldPaths).forEach(([fieldName, path]) => {
    const results = JSONPath({ path, json: rootData });
    if (results.length > 0) {
      result[fieldName] = results[0];
    } else {
      result[fieldName] = null;
    }
  });

  if (instructions.outputType === "array") {
    // If rootData is an array, extract from each item
    if (Array.isArray(rootData)) {
      return rootData.map((item) => {
        const itemResult: Record<string, any> = {};
        Object.entries(jsonPath.fieldPaths).forEach(([fieldName, path]) => {
          const results = JSONPath({ path, json: item });
          if (results.length > 0) {
            itemResult[fieldName] = results[0];
          } else {
            itemResult[fieldName] = null;
          }
        });
        return itemResult;
      });
    }
    // If rootData is an object, try to find array in it
    const arrayPath = jsonPath.rootPath || "$";
    const arrayResults = JSONPath({ path: arrayPath, json });
    if (Array.isArray(arrayResults[0])) {
      return arrayResults[0].map((item: any) => {
        const itemResult: Record<string, any> = {};
        Object.entries(jsonPath.fieldPaths).forEach(([fieldName, path]) => {
          const results = JSONPath({ path, json: item });
          if (results.length > 0) {
            itemResult[fieldName] = results[0];
          } else {
            itemResult[fieldName] = null;
          }
        });
        return itemResult;
      });
    }
    return [result];
  }

  return result;
}

/**
 * Strip pseudo-elements from a selector string
 * Removes ::text, ::attr(...), ::html, etc. from anywhere in the selector
 */
function stripPseudoElements(selector: string): string {
  if (!selector) return selector;

  // Remove ::text, ::html (at end or anywhere)
  selector = selector.replace(/::text\b/g, "");
  selector = selector.replace(/::html\b/g, "");
  // Remove ::attr(...) - matches ::attr(anything)
  selector = selector.replace(/::attr\([^)]*\)/g, "");
  return selector.trim();
}

/**
 * Extract data from HTML/XML response
 */
function extractFromHTML(
  body: string,
  instructions: ScrapingInstructions
): any {
  const $ = cheerio.load(body);
  const { extraction } = instructions;

  if (!extraction) {
    throw new Error("Missing extraction in instructions for HTML/XML response");
  }

  const parseSelector = (
    selector: string | { selector: string; type?: string; attribute?: string }
  ): { selector: string; type: string; attribute?: string } => {
    if (typeof selector === "string") {
      // Parse format: "selector::text" or "selector::attr(name)" or "selector::html"
      const textMatch = selector.match(/^(.+)::text$/);
      const attrMatch = selector.match(/^(.+)::attr\(([^)]+)\)$/);
      const htmlMatch = selector.match(/^(.+)::html$/);

      if (textMatch && textMatch[1]) {
        return { selector: stripPseudoElements(textMatch[1]), type: "text" };
      } else if (attrMatch && attrMatch[1] && attrMatch[2]) {
        return {
          selector: stripPseudoElements(attrMatch[1]),
          type: "attr",
          attribute: attrMatch[2],
        };
      } else if (htmlMatch && htmlMatch[1]) {
        return { selector: stripPseudoElements(htmlMatch[1]), type: "html" };
      }
      return { selector: stripPseudoElements(selector), type: "text" };
    }
    return {
      selector: stripPseudoElements(selector.selector),
      type: selector.type || "text",
      attribute: selector.attribute,
    };
  };

  const extractField = (
    element: cheerio.Cheerio<any>,
    fieldSelector: any
  ): any => {
    // Handle nested array extraction
    if (
      typeof fieldSelector === "object" &&
      "type" in fieldSelector &&
      fieldSelector.type === "array" &&
      "containerSelector" in fieldSelector &&
      "selectors" in fieldSelector
    ) {
      const nestedExtraction = fieldSelector as {
        type: string;
        containerSelector: string;
        selectors: Record<string, any>;
      };
      const cleanContainerSelector = stripPseudoElements(
        nestedExtraction.containerSelector
      );
      const containers = element.find(cleanContainerSelector);
      const nestedResults: any[] = [];

      containers.each((_, nestedElement) => {
        const $nestedElement = $(nestedElement);
        const nestedItem: Record<string, any> = {};

        Object.entries(nestedExtraction.selectors).forEach(
          ([nestedFieldName, nestedFieldSelector]) => {
            // Handle relative selectors (starting with ::)
            if (
              typeof nestedFieldSelector === "string" &&
              nestedFieldSelector.startsWith("::")
            ) {
              // Relative selector - apply to current element
              const relativeSelector = nestedFieldSelector.substring(2);
              if (relativeSelector.startsWith("attr(")) {
                const attrMatch = relativeSelector.match(/^attr\(([^)]+)\)$/);
                if (attrMatch && attrMatch[1]) {
                  nestedItem[nestedFieldName] =
                    $nestedElement.attr(attrMatch[1]) || null;
                }
              } else if (relativeSelector === "text") {
                nestedItem[nestedFieldName] = $nestedElement.text().trim();
              } else if (relativeSelector === "html") {
                nestedItem[nestedFieldName] = $nestedElement.html() || null;
              } else {
                // Unknown relative selector
                nestedItem[nestedFieldName] = null;
              }
            } else if (
              typeof nestedFieldSelector === "string" &&
              nestedFieldSelector.includes("ancestor::")
            ) {
              // XPath ancestor selector - cheerio doesn't support XPath
              // Try to find the ancestor using CSS selectors
              console.warn(
                `XPath selector "${nestedFieldSelector}" is not fully supported. Attempting CSS alternative.`
              );
              // Extract the attribute name if present
              const attrMatch = nestedFieldSelector.match(/::attr\(([^)]+)\)$/);
              if (attrMatch && attrMatch[1]) {
                // Try to find a button ancestor
                const button = $nestedElement.closest("button");
                if (button.length > 0) {
                  nestedItem[nestedFieldName] =
                    button.attr(attrMatch[1]) || null;
                } else {
                  nestedItem[nestedFieldName] = null;
                }
              } else {
                nestedItem[nestedFieldName] = null;
              }
            } else {
              // Regular selector - extract from nested element
              nestedItem[nestedFieldName] = extractField(
                $nestedElement,
                nestedFieldSelector
              );
            }
          }
        );

        nestedResults.push(nestedItem);
      });

      return nestedResults;
    }

    // Handle simple selectors
    const parsed = parseSelector(fieldSelector);
    const selected = element.find(parsed.selector).first();

    if (parsed.type === "text") {
      return selected.text().trim();
    } else if (parsed.type === "attr" && parsed.attribute) {
      return selected.attr(parsed.attribute) || null;
    } else if (parsed.type === "html") {
      return selected.html() || null;
    }
    return selected.text().trim();
  };

  if (instructions.outputType === "array") {
    if (!extraction.containerSelector) {
      throw new Error("containerSelector is required for array output");
    }

    // Strip pseudo-elements from containerSelector before using it
    const cleanContainerSelector = stripPseudoElements(
      extraction.containerSelector
    );
    const containers = $(cleanContainerSelector);
    const results: any[] = [];

    console.log(
      `Found ${containers.length} container elements with selector: ${cleanContainerSelector}`
    );

    containers.each((_, element) => {
      const $element = $(element);
      const item: Record<string, any> = {};

      Object.entries(extraction.selectors).forEach(
        ([fieldName, fieldSelector]) => {
          try {
            item[fieldName] = extractField($element, fieldSelector);
          } catch (error) {
            console.warn(`Error extracting field "${fieldName}":`, error);
            item[fieldName] = null;
          }
        }
      );

      results.push(item);
    });

    console.log(`Extracted ${results.length} items`);
    return results;
  } else {
    // Single object extraction
    const result: Record<string, any> = {};
    Object.entries(extraction.selectors).forEach(
      ([fieldName, fieldSelector]) => {
        const parsed = parseSelector(fieldSelector);
        const selected = $(parsed.selector).first();

        if (parsed.type === "text") {
          result[fieldName] = selected.text().trim();
        } else if (parsed.type === "attr" && parsed.attribute) {
          result[fieldName] = selected.attr(parsed.attribute) || null;
        } else if (parsed.type === "html") {
          result[fieldName] = selected.html() || null;
        } else {
          result[fieldName] = selected.text().trim();
        }
      }
    );

    return result;
  }
}

/**
 * Extract data from response body based on instructions
 */
function extractData(body: string, instructions: ScrapingInstructions): any {
  if (instructions.responseType === "json") {
    return extractFromJSON(body, instructions);
  } else if (
    instructions.responseType === "html" ||
    instructions.responseType === "xml"
  ) {
    return extractFromHTML(body, instructions);
  } else {
    throw new Error(`Unsupported response type: ${instructions.responseType}`);
  }
}

/**
 * Scrape using stored instructions
 */
export async function scrapeWithInstructions(
  id: string,
  paginationOptions: PaginationOptions = {}
): Promise<ScrapeResult> {
  const metadata = getScrapingInstructions(id);
  if (!metadata) {
    throw new Error(`Scraping instructions not found for ID: ${id}`);
  }

  const { instructions } = metadata;

  console.log(`\n=== SCRAPING WITH INSTRUCTIONS ===`);
  console.log(`ID: ${id}`);
  console.log(`Method: ${instructions.method}`);
  console.log(`Base URL: ${instructions.baseUrl}`);
  console.log(`Response Type: ${instructions.responseType}`);
  console.log(`Output Type: ${instructions.outputType}`);
  if (paginationOptions.page !== undefined) {
    console.log(`Page: ${paginationOptions.page}`);
  }
  if (paginationOptions.offset !== undefined) {
    console.log(`Offset: ${paginationOptions.offset}`);
  }

  try {
    const responseBody = await makeRequest(instructions, paginationOptions);
    const data = extractData(responseBody, instructions);

    const result: ScrapeResult = {
      data,
      pagination: {
        page: paginationOptions.page,
        limit: paginationOptions.limit,
        offset: paginationOptions.offset,
      },
    };

    console.log(
      `✅ Scraping completed. Extracted ${
        Array.isArray(data) ? data.length : 1
      } item(s)`
    );
    return result;
  } catch (error) {
    console.error("❌ Scraping failed:", error);
    throw error;
  }
}
