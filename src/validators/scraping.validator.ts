import { type ScrapingInstructions } from "../types";

/**
 * Validate scraping instructions structure
 */
export function validateScrapingInstructions(
  instructions: ScrapingInstructions
): void {
  // Validate required fields
  if (!instructions.method) {
    throw new Error("Missing required field: method");
  }
  if (!instructions.baseUrl) {
    throw new Error("Missing required field: baseUrl");
  }
  if (!instructions.responseType) {
    throw new Error("Missing required field: responseType");
  }
  if (!instructions.outputType) {
    throw new Error("Missing required field: outputType");
  }
  if (!instructions.schema) {
    throw new Error("Missing required field: schema");
  }

  // Validate responseType
  if (!["json", "html", "xml"].includes(instructions.responseType)) {
    throw new Error(
      `Invalid responseType: ${instructions.responseType}. Must be json, html, or xml`
    );
  }

  // Validate outputType
  if (!["array", "object"].includes(instructions.outputType)) {
    throw new Error(
      `Invalid outputType: ${instructions.outputType}. Must be array or object`
    );
  }

  // Validate schema type matches outputType
  if (instructions.schema.type !== instructions.outputType) {
    throw new Error(
      `Schema type (${instructions.schema.type}) does not match outputType (${instructions.outputType})`
    );
  }

  // Validate extraction for HTML/XML
  if (
    instructions.responseType === "html" ||
    instructions.responseType === "xml"
  ) {
    if (!instructions.extraction) {
      throw new Error(
        `Missing extraction object for ${instructions.responseType} response type`
      );
    }
    if (
      instructions.outputType === "array" &&
      !instructions.extraction.containerSelector
    ) {
      console.warn(
        "⚠️  Warning: outputType is array but containerSelector is missing"
      );
    }
    if (
      !instructions.extraction.selectors ||
      Object.keys(instructions.extraction.selectors).length === 0
    ) {
      throw new Error("Missing or empty selectors in extraction object");
    }
  }

  // Validate jsonPath for JSON
  if (instructions.responseType === "json") {
    if (!instructions.jsonPath) {
      throw new Error("Missing jsonPath object for JSON response type");
    }
    if (
      !instructions.jsonPath.fieldPaths ||
      Object.keys(instructions.jsonPath.fieldPaths).length === 0
    ) {
      throw new Error("Missing or empty fieldPaths in jsonPath object");
    }
  }

  // Validate schema structure
  if (instructions.schema.type === "array") {
    if (!instructions.schema.items) {
      throw new Error("Schema type is array but items schema is missing");
    }
  } else if (instructions.schema.type === "object") {
    if (
      !instructions.schema.properties ||
      Object.keys(instructions.schema.properties).length === 0
    ) {
      throw new Error(
        "Schema type is object but properties are missing or empty"
      );
    }
  }

  console.log("   ✅ Scraping instructions validation passed");
}

