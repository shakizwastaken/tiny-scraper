import type { JSONSchema } from "../types/scraping";

/**
 * Generate a JSON schema from extracted data
 * Supports unlimited recursive nested arrays and advanced JSON Schema features
 */
export function generateSchemaFromData(
  data: any,
  depth: number = 0
): JSONSchema {
  // Safety limit to prevent infinite recursion (though should not be needed)
  const MAX_DEPTH = 100;
  if (depth > MAX_DEPTH) {
    return { type: "object", description: "Maximum depth reached" };
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return {
        type: "array",
        items: { type: "object", properties: {} },
        minItems: 0,
      };
    }

    // Analyze all items to detect union types and constraints
    const itemSchemas = data.map((item) =>
      generateSchemaFromData(item, depth + 1)
    );

    // Check if all items have the same schema
    const firstSchema = itemSchemas[0];
    if (!firstSchema) {
      return { type: "array", items: { type: "object", properties: {} } };
    }

    const allSame = itemSchemas.every(
      (schema) => JSON.stringify(schema) === JSON.stringify(firstSchema)
    );

    if (allSame) {
      // All items have the same structure
      const schema: JSONSchema = {
        type: "array",
        items: firstSchema,
        minItems: data.length > 0 ? 1 : 0,
      };

      // Add constraints if we have multiple items
      if (data.length > 1) {
        schema.minItems = 1;
      }

      return schema;
    } else {
      // Items have different structures - use oneOf
      const uniqueSchemas = getUniqueSchemas(itemSchemas);
      if (uniqueSchemas.length === 1) {
        return {
          type: "array",
          items: uniqueSchemas[0],
          minItems: data.length > 0 ? 1 : 0,
        };
      } else {
        return {
          type: "array",
          items: {
            oneOf: uniqueSchemas,
          },
          minItems: data.length > 0 ? 1 : 0,
        };
      }
    }
  } else if (typeof data === "object" && data !== null) {
    return generateObjectSchema(data, depth);
  } else {
    // Primitive value
    return generatePrimitiveSchema(data);
  }
}

/**
 * Generate schema for an object (recursively handles nested structures)
 */
function generateObjectSchema(
  obj: Record<string, any>,
  depth: number = 0
): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      // Nullable field - use oneOf with null
      properties[key] = {
        oneOf: [{ type: "string" }, { type: "null" }],
      };
      continue;
    }

    if (Array.isArray(value)) {
      // Recursively generate schema for nested arrays (unlimited depth)
      properties[key] = generateSchemaFromData(value, depth + 1);

      // Add array constraints
      if (value.length > 0) {
        properties[key].minItems = 1;
      }
    } else if (typeof value === "object") {
      // Recursively generate schema for nested objects
      properties[key] = generateObjectSchema(value, depth + 1);
    } else {
      properties[key] = generatePrimitiveSchema(value);
      required.push(key);
    }
  }

  const schema: JSONSchema = {
    type: "object",
    properties,
  };

  if (required.length > 0) {
    schema.required = required;
  }

  return schema;
}

/**
 * Generate schema for a primitive value with constraints
 */
function generatePrimitiveSchema(value: any): JSONSchema {
  const type = getTypeString(value);
  const schema: JSONSchema = { type };

  if (type === "string") {
    // Add format for special string types
    if (isUrl(value)) {
      schema.format = "uri";
    } else if (isEmail(value)) {
      schema.format = "email";
    } else if (isDateString(value)) {
      schema.format = "date-time";
    }

    // Add length constraints
    if (typeof value === "string") {
      schema.minLength = value.length > 0 ? 1 : 0;
      schema.maxLength = value.length;
    }
  } else if (type === "number") {
    // Add numeric constraints
    if (typeof value === "number") {
      schema.minimum = value;
      schema.maximum = value;
    }
  }

  return schema;
}

/**
 * Get unique schemas from an array (for oneOf generation)
 */
function getUniqueSchemas(schemas: JSONSchema[]): JSONSchema[] {
  const unique: JSONSchema[] = [];
  const seen = new Set<string>();

  for (const schema of schemas) {
    const key = JSON.stringify(schema);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(schema);
    }
  }

  return unique;
}

/**
 * Get JSON schema type string from a value
 */
function getTypeString(value: any): string {
  if (value === null || value === undefined) {
    return "string"; // Default to string
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "object") {
    return "object";
  }
  return typeof value;
}

/**
 * Check if a string looks like a URL
 */
function isUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a string looks like an email
 */
function isEmail(str: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

/**
 * Check if a string looks like a date
 */
function isDateString(str: string): boolean {
  return !isNaN(Date.parse(str));
}
