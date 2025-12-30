import { eq } from "drizzle-orm";
import { db, scrapingInstructions, scrapeResults, testResults } from "../db";
import { type ScrapingInstructions } from "../types";
import type { TestResults as TestResultsType } from "../types/scraping";

export interface ScrapingInstructionMetadata {
  id: string;
  instructions: ScrapingInstructions;
  metadata: {
    createdAt: string;
    originalUrl: string;
    originalSearch: string;
  };
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
export async function saveScrapingInstructions(
  instructions: ScrapingInstructions,
  originalUrl: string,
  originalSearch: string
): Promise<string> {
  const [result] = await db
    .insert(scrapingInstructions)
    .values({
      instructions,
      originalUrl,
      originalSearch,
    })
    .returning({ id: scrapingInstructions.id });

  const id = result.id;

  console.log(`✅ Saved scraping instructions with ID: ${id}`);
  return id;
}

/**
 * Update existing scraping instructions
 */
export async function updateScrapingInstructions(
  id: string,
  instructions: ScrapingInstructions
): Promise<void> {
  const result = await db
    .update(scrapingInstructions)
    .set({
      instructions,
      updatedAt: new Date(),
    })
    .where(eq(scrapingInstructions.id, id))
    .returning({ id: scrapingInstructions.id });

  if (result.length === 0) {
    throw new Error(`Instructions not found for ID: ${id}`);
  }

  console.log(`✅ Updated scraping instructions with ID: ${id}`);
}

/**
 * Get scraping instructions by ID
 */
export async function getScrapingInstructions(
  id: string
): Promise<ScrapingInstructionMetadata | null> {
  const result = await db
    .select()
    .from(scrapingInstructions)
    .where(eq(scrapingInstructions.id, id))
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  const row = result[0];
  return {
    id: row.id,
    instructions: row.instructions,
    metadata: {
      createdAt: row.createdAt.toISOString(),
      originalUrl: row.originalUrl,
      originalSearch: row.originalSearch,
    },
  };
}

/**
 * Get scraping metadata by ID (without full instructions)
 */
export async function getScrapingMetadata(id: string): Promise<{
  id: string;
  metadata: ScrapingInstructionMetadata["metadata"];
  schema: ScrapingInstructions["schema"];
  responseType: string;
  outputType: string;
  hasPagination: boolean;
} | null> {
  const item = await getScrapingInstructions(id);
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

/**
 * Save scrape result to database
 */
export async function saveScrapeResult(
  instructionId: string,
  data: any,
  pagination?: {
    page?: number;
    limit?: number;
    offset?: number;
    hasMore?: boolean;
  }
): Promise<string> {
  const [result] = await db
    .insert(scrapeResults)
    .values({
      instructionId,
      data,
      pagination: pagination || null,
    })
    .returning({ id: scrapeResults.id });

  const id = result.id;
  console.log(`✅ Saved scrape result with ID: ${id}`);
  return id;
}

/**
 * Save test result to database
 */
export async function saveTestResult(
  instructionId: string,
  testResult: TestResultsType
): Promise<string> {
  const [result] = await db
    .insert(testResults)
    .values({
      instructionId,
      success: testResult.success,
      extractedData: testResult.extractedData || null,
      errors: testResult.errors || null,
      schemaValidationErrors: testResult.schemaValidationErrors || null,
      requiredFieldsMissing: testResult.requiredFieldsMissing || null,
      debugInfo: testResult.debugInfo || null,
    })
    .returning({ id: testResults.id });

  const id = result.id;
  console.log(`✅ Saved test result with ID: ${id}`);
  return id;
}

/**
 * Get scrape results for a given instruction ID
 */
export async function getScrapeResults(instructionId: string) {
  return await db
    .select()
    .from(scrapeResults)
    .where(eq(scrapeResults.instructionId, instructionId))
    .orderBy(scrapeResults.executedAt);
}

/**
 * Get test results for a given instruction ID
 */
export async function getTestResults(instructionId: string) {
  return await db
    .select()
    .from(testResults)
    .where(eq(testResults.instructionId, instructionId))
    .orderBy(testResults.testedAt);
}
