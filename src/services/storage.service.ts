import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { type ScrapingInstructions } from "../types";

const DATA_DIR = join(process.cwd(), "data");
const STORAGE_FILE = join(DATA_DIR, "scraping-instructions.json");

export interface ScrapingInstructionMetadata {
  id: string;
  instructions: ScrapingInstructions;
  metadata: {
    createdAt: string;
    originalUrl: string;
    originalSearch: string;
  };
}

interface StorageData {
  [id: string]: ScrapingInstructionMetadata;
}

/**
 * Ensure data directory exists
 */
function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Read storage file
 */
function readStorage(): StorageData {
  ensureDataDir();
  if (!existsSync(STORAGE_FILE)) {
    return {};
  }
  try {
    const content = readFileSync(STORAGE_FILE, "utf-8");
    return JSON.parse(content) as StorageData;
  } catch (error) {
    console.error("Error reading storage file:", error);
    return {};
  }
}

/**
 * Write storage file atomically
 */
function writeStorage(data: StorageData): void {
  ensureDataDir();
  try {
    writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    console.error("Error writing storage file:", error);
    throw new Error("Failed to save scraping instructions");
  }
}

/**
 * Generate unique ID using crypto
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Save scraping instructions to storage
 */
export function saveScrapingInstructions(
  instructions: ScrapingInstructions,
  originalUrl: string,
  originalSearch: string
): string {
  const id = generateId();
  const storage = readStorage();

  const metadata: ScrapingInstructionMetadata = {
    id,
    instructions,
    metadata: {
      createdAt: new Date().toISOString(),
      originalUrl,
      originalSearch,
    },
  };

  storage[id] = metadata;
  writeStorage(storage);

  console.log(`✅ Saved scraping instructions with ID: ${id}`);
  return id;
}

/**
 * Update existing scraping instructions
 */
export function updateScrapingInstructions(
  id: string,
  instructions: ScrapingInstructions
): void {
  const storage = readStorage();
  const existing = storage[id];

  if (!existing) {
    throw new Error(`Instructions not found for ID: ${id}`);
  }

  // Update instructions while preserving metadata
  storage[id] = {
    ...existing,
    instructions,
  };

  writeStorage(storage);

  console.log(`✅ Updated scraping instructions with ID: ${id}`);
}

/**
 * Get scraping instructions by ID
 */
export function getScrapingInstructions(
  id: string
): ScrapingInstructionMetadata | null {
  const storage = readStorage();
  return storage[id] || null;
}

/**
 * Get scraping metadata by ID (without full instructions)
 */
export function getScrapingMetadata(id: string): {
  id: string;
  metadata: ScrapingInstructionMetadata["metadata"];
  schema: ScrapingInstructions["schema"];
  responseType: string;
  outputType: string;
  hasPagination: boolean;
} | null {
  const item = getScrapingInstructions(id);
  if (!item) {
    return null;
  }

  return {
    id: item.id,
    metadata: item.metadata,
    schema: item.instructions.schema,
    responseType: item.instructions.responseType,
    outputType: item.instructions.outputType,
    hasPagination: !!item.instructions.pagination,
  };
}
