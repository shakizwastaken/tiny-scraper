import { pgTable, uuid, text, jsonb, timestamp, boolean } from "drizzle-orm/pg-core";
import type { ScrapingInstructions, TestResults } from "../types/scraping";

/**
 * Table for storing scraping instructions and metadata
 */
export const scrapingInstructions = pgTable("scraping_instructions", {
  id: uuid("id").primaryKey().defaultRandom(),
  instructions: jsonb("instructions").$type<ScrapingInstructions>().notNull(),
  originalUrl: text("original_url").notNull(),
  originalSearch: text("original_search").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Table for storing scrape execution results
 */
export const scrapeResults = pgTable("scrape_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  instructionId: uuid("instruction_id")
    .references(() => scrapingInstructions.id, { onDelete: "cascade" })
    .notNull(),
  data: jsonb("data").notNull(), // The scraped data (array or object)
  pagination: jsonb("pagination").$type<{
    page?: number;
    limit?: number;
    offset?: number;
    hasMore?: boolean;
  }>(),
  executedAt: timestamp("executed_at").defaultNow().notNull(),
});

/**
 * Table for storing test results from instruction testing
 */
export const testResults = pgTable("test_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  instructionId: uuid("instruction_id")
    .references(() => scrapingInstructions.id, { onDelete: "cascade" })
    .notNull(),
  success: boolean("success").notNull(),
  extractedData: jsonb("extracted_data"), // Sample of extracted data
  errors: jsonb("errors").$type<string[]>(),
  schemaValidationErrors: jsonb("schema_validation_errors").$type<string[]>(),
  requiredFieldsMissing: jsonb("required_fields_missing").$type<string[]>(),
  debugInfo: jsonb("debug_info").$type<Record<string, any>>(),
  testedAt: timestamp("tested_at").defaultNow().notNull(),
});

export type ScrapingInstruction = typeof scrapingInstructions.$inferSelect;
export type NewScrapingInstruction = typeof scrapingInstructions.$inferInsert;
export type ScrapeResult = typeof scrapeResults.$inferSelect;
export type NewScrapeResult = typeof scrapeResults.$inferInsert;
export type TestResult = typeof testResults.$inferSelect;
export type NewTestResult = typeof testResults.$inferInsert;

