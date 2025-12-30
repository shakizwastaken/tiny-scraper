import { eq, desc } from "drizzle-orm";
import {
  db,
  scrapingInstructions,
  scrapeResults,
  testResults,
  instructionSnapshots,
} from "../db";
import { type ScrapingInstructions } from "../types";
import type { TestResults as TestResultsType } from "../types/scraping";

export interface ScrapingInstructionMetadata {
  id: string;
  instructions: ScrapingInstructions;
  metadata: {
    createdAt: string;
    originalUrl: string;
    originalSearch: string;
    expectedOutputType?: "array" | "object";
    customPrompt?: string;
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
  originalSearch: string,
  expectedOutputType?: "array" | "object",
  customPrompt?: string
): Promise<string> {
  const [result] = await db
    .insert(scrapingInstructions)
    .values({
      instructions,
      originalUrl,
      originalSearch,
      expectedOutputType: expectedOutputType || null,
      customPrompt: customPrompt || null,
    })
    .returning({ id: scrapingInstructions.id });

  const id = result.id;

  // Create initial snapshot (version 1)
  await db.insert(instructionSnapshots).values({
    instructionId: id,
    version: 1,
    instructions,
  });

  console.log(`✅ Saved scraping instructions with ID: ${id} (initial version 1)`);
  return id;
}

/**
 * Update existing scraping instructions
 */
export async function updateScrapingInstructions(
  id: string,
  instructions: ScrapingInstructions
): Promise<void> {
  // Get current version count for this instruction
  const currentSnapshots = await db
    .select()
    .from(instructionSnapshots)
    .where(eq(instructionSnapshots.instructionId, id))
    .orderBy(desc(instructionSnapshots.version));

  // Get current instructions from the main table to check if they changed
  const currentInstruction = await db
    .select()
    .from(scrapingInstructions)
    .where(eq(scrapingInstructions.id, id))
    .limit(1);

  if (currentInstruction.length === 0) {
    throw new Error(`Instructions not found for ID: ${id}`);
  }

  // Check if instructions actually changed
  const instructionsChanged = JSON.stringify(currentInstruction[0].instructions) !== JSON.stringify(instructions);

  // Only create a new snapshot if instructions actually changed
  if (instructionsChanged) {
    const nextVersion = currentSnapshots.length > 0 
      ? currentSnapshots[0].version + 1 
      : 2; // If no snapshots exist, this is version 2 (version 1 was created on initial save)

    // Update the main instructions table
    await db
      .update(scrapingInstructions)
      .set({
        instructions,
        updatedAt: new Date(),
      })
      .where(eq(scrapingInstructions.id, id));

    // Create snapshot of the new version
    await db.insert(instructionSnapshots).values({
      instructionId: id,
      version: nextVersion,
      instructions,
    });

    console.log(`✅ Updated scraping instructions with ID: ${id} (version ${nextVersion})`);
  } else {
    // Instructions didn't change, just update timestamp
    await db
      .update(scrapingInstructions)
      .set({
        updatedAt: new Date(),
      })
      .where(eq(scrapingInstructions.id, id));

    console.log(`✅ Updated timestamp for instructions with ID: ${id} (no changes, no new snapshot)`);
  }
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
      expectedOutputType: row.expectedOutputType || undefined,
      customPrompt: row.customPrompt || undefined,
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
    .orderBy(desc(testResults.testedAt));
}
