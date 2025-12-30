import type { JSONSchema } from "../types/scraping";

/**
 * Generate a JSON schema from extracted data
 */
export function generateSchemaFromData(data: any): JSONSchema {
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return {
        type: "array",
        items: { type: "object", properties: {} },
      };
    }
    
    // Generate schema from first item
    const itemSchema = generateObjectSchema(data[0]);
    return {
      type: "array",
      items: itemSchema,
    };
  } else if (typeof data === "object" && data !== null) {
    return generateObjectSchema(data);
  } else {
    // Primitive value
    return {
      type: getTypeString(data),
    };
  }
}

/**
 * Generate schema for an object
 */
function generateObjectSchema(obj: Record<string, any>): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      properties[key] = { type: "string" }; // Default to string for null values
      continue;
    }
    
    if (Array.isArray(value)) {
      if (value.length === 0) {
        properties[key] = {
          type: "array",
          items: { type: "string" }, // Default
        };
      } else {
        const itemType = getTypeString(value[0]);
        properties[key] = {
          type: "array",
          items: { type: itemType },
        };
      }
    } else if (typeof value === "object") {
      properties[key] = generateObjectSchema(value);
    } else {
      const type = getTypeString(value);
      properties[key] = { type };
      
      // Add format for special string types
      if (type === "string") {
        if (isUrl(value)) {
          properties[key].format = "uri";
        } else if (isEmail(value)) {
          properties[key].format = "email";
        } else if (isDateString(value)) {
          properties[key].format = "date-time";
        }
      }
    }
  }
  
  return {
    type: "object",
    properties,
  };
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

