import {
  type ScrapingInstructions,
  type NestedExtractionConfig,
} from "../types";

/**
 * Recursively validate nested extraction config
 */
function validateNestedExtractionConfig(config: any, path: string = ""): void {
  if (!config || typeof config !== "object") {
    throw new Error(
      `Invalid nested extraction config at ${path}: must be an object`
    );
  }

  if (config.type !== "array") {
    throw new Error(
      `Invalid nested extraction config type at ${path}: must be "array"`
    );
  }

  if (!config.containerSelector && !config.jsonPath) {
    throw new Error(
      `Nested extraction config at ${path} must have either containerSelector (for HTML) or jsonPath (for JSON)`
    );
  }

  if (!config.selectors || typeof config.selectors !== "object") {
    throw new Error(
      `Nested extraction config at ${path} must have selectors object`
    );
  }

  if (Object.keys(config.selectors).length === 0) {
    throw new Error(
      `Nested extraction config at ${path} must have at least one selector`
    );
  }

  // Recursively validate nested selectors
  Object.entries(config.selectors).forEach(([key, value]) => {
    if (value && typeof value === "object" && (value as any).type === "array") {
      validateNestedExtractionConfig(value, `${path}.${key}`);
    }
  });
}

/**
 * Validate advanced JSON Schema features
 */
function validateJSONSchema(schema: any, path: string = "schema"): void {
  if (!schema || typeof schema !== "object") {
    throw new Error(`Invalid schema at ${path}: must be an object`);
  }

  // Validate type (can be string, array of strings, or undefined for anyOf/allOf/oneOf)
  if (schema.type !== undefined) {
    if (typeof schema.type === "string") {
      const validTypes = [
        "string",
        "number",
        "integer",
        "boolean",
        "array",
        "object",
        "null",
      ];
      if (!validTypes.includes(schema.type)) {
        throw new Error(`Invalid schema type at ${path}: ${schema.type}`);
      }
    } else if (Array.isArray(schema.type)) {
      // Multiple types (union type)
      schema.type.forEach((t: string, i: number) => {
        const validTypes = [
          "string",
          "number",
          "integer",
          "boolean",
          "array",
          "object",
          "null",
        ];
        if (!validTypes.includes(t)) {
          throw new Error(`Invalid schema type at ${path}.type[${i}]: ${t}`);
        }
      });
    } else {
      throw new Error(
        `Invalid schema type at ${path}: must be string or array of strings`
      );
    }
  }

  // Validate anyOf, allOf, oneOf (advanced features)
  if (schema.anyOf) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      throw new Error(`Schema anyOf at ${path} must be a non-empty array`);
    }
    schema.anyOf.forEach((subSchema: any, i: number) => {
      validateJSONSchema(subSchema, `${path}.anyOf[${i}]`);
    });
  }

  if (schema.allOf) {
    if (!Array.isArray(schema.allOf) || schema.allOf.length === 0) {
      throw new Error(`Schema allOf at ${path} must be a non-empty array`);
    }
    schema.allOf.forEach((subSchema: any, i: number) => {
      validateJSONSchema(subSchema, `${path}.allOf[${i}]`);
    });
  }

  if (schema.oneOf) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) {
      throw new Error(`Schema oneOf at ${path} must be a non-empty array`);
    }
    schema.oneOf.forEach((subSchema: any, i: number) => {
      validateJSONSchema(subSchema, `${path}.oneOf[${i}]`);
    });
  }

  if (schema.not) {
    validateJSONSchema(schema.not, `${path}.not`);
  }

  // Validate enum
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) {
      throw new Error(`Schema enum at ${path} must be an array`);
    }
  }

  // Validate array constraints
  if (schema.minItems !== undefined && typeof schema.minItems !== "number") {
    throw new Error(`Schema minItems at ${path} must be a number`);
  }
  if (schema.maxItems !== undefined && typeof schema.maxItems !== "number") {
    throw new Error(`Schema maxItems at ${path} must be a number`);
  }
  if (
    schema.uniqueItems !== undefined &&
    typeof schema.uniqueItems !== "boolean"
  ) {
    throw new Error(`Schema uniqueItems at ${path} must be a boolean`);
  }

  // Validate string constraints
  if (schema.minLength !== undefined && typeof schema.minLength !== "number") {
    throw new Error(`Schema minLength at ${path} must be a number`);
  }
  if (schema.maxLength !== undefined && typeof schema.maxLength !== "number") {
    throw new Error(`Schema maxLength at ${path} must be a number`);
  }
  if (schema.pattern !== undefined && typeof schema.pattern !== "string") {
    throw new Error(`Schema pattern at ${path} must be a string`);
  }

  // Validate number constraints
  if (schema.minimum !== undefined && typeof schema.minimum !== "number") {
    throw new Error(`Schema minimum at ${path} must be a number`);
  }
  if (schema.maximum !== undefined && typeof schema.maximum !== "number") {
    throw new Error(`Schema maximum at ${path} must be a number`);
  }
  if (
    schema.multipleOf !== undefined &&
    typeof schema.multipleOf !== "number"
  ) {
    throw new Error(`Schema multipleOf at ${path} must be a number`);
  }

  // Validate nullable
  if (schema.nullable !== undefined && typeof schema.nullable !== "boolean") {
    throw new Error(`Schema nullable at ${path} must be a boolean`);
  }

  // Recursively validate nested schemas
  if (schema.items) {
    if (Array.isArray(schema.items)) {
      schema.items.forEach((item: any, i: number) => {
        validateJSONSchema(item, `${path}.items[${i}]`);
      });
    } else {
      validateJSONSchema(schema.items, `${path}.items`);
    }
  }

  if (schema.properties) {
    Object.entries(schema.properties).forEach(([key, value]) => {
      validateJSONSchema(value, `${path}.properties.${key}`);
    });
  }

  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    validateJSONSchema(
      schema.additionalProperties,
      `${path}.additionalProperties`
    );
  }

  if (schema.patternProperties) {
    Object.entries(schema.patternProperties).forEach(([key, value]) => {
      validateJSONSchema(value, `${path}.patternProperties.${key}`);
    });
  }
}

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

  // Schema is optional - it will be generated automatically from extracted data
  if (instructions.schema) {
    // Validate advanced JSON Schema features
    validateJSONSchema(instructions.schema, "schema");

    // Validate schema type matches outputType if schema is provided (with advanced features support)
    const schemaType = Array.isArray(instructions.schema.type)
      ? instructions.schema.type
      : instructions.schema.type
      ? [instructions.schema.type]
      : [];

    // For anyOf/allOf/oneOf, type might be undefined
    if (
      schemaType.length > 0 &&
      !instructions.schema.anyOf &&
      !instructions.schema.allOf &&
      !instructions.schema.oneOf
    ) {
      const hasMatchingType = schemaType.includes(instructions.outputType);
      if (!hasMatchingType) {
        console.warn(
          `⚠️  Schema type (${JSON.stringify(
            schemaType
          )}) does not match outputType (${instructions.outputType})`
        );
      }
    }
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

    // Validate nested extraction configs
    Object.entries(instructions.extraction.selectors).forEach(
      ([key, value]) => {
        if (
          value &&
          typeof value === "object" &&
          (value as any).type === "array"
        ) {
          validateNestedExtractionConfig(value, `extraction.selectors.${key}`);
        }
      }
    );
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

    // Validate nested extraction configs
    Object.entries(instructions.jsonPath.fieldPaths).forEach(([key, value]) => {
      if (
        value &&
        typeof value === "object" &&
        (value as any).type === "array"
      ) {
        validateNestedExtractionConfig(value, `jsonPath.fieldPaths.${key}`);
      }
    });
  }

  // Validate schema structure if schema is provided (already validated by validateJSONSchema above)
  // Additional validation for basic structure
  if (instructions.schema) {
    const schemaType = Array.isArray(instructions.schema.type)
      ? instructions.schema.type
      : instructions.schema.type
      ? [instructions.schema.type]
      : [];

    // For schemas with explicit type (not anyOf/allOf/oneOf)
    if (
      schemaType.length > 0 &&
      !instructions.schema.anyOf &&
      !instructions.schema.allOf &&
      !instructions.schema.oneOf
    ) {
      if (schemaType.includes("array")) {
        if (!instructions.schema.items) {
          console.warn(
            "⚠️  Warning: Schema type is array but items schema is missing"
          );
        }
      } else if (schemaType.includes("object")) {
        if (
          !instructions.schema.properties ||
          Object.keys(instructions.schema.properties).length === 0
        ) {
          console.warn(
            "⚠️  Warning: Schema type is object but properties are missing or empty"
          );
        }
      }
    }
  }

  console.log("   ✅ Scraping instructions validation passed");
}
