import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  boolean,
  integer,
} from "drizzle-orm/pg-core";
import type { ScrapingInstructions, TestResults } from "../types/scraping";

/**
 * Table for storing scraping instructions and metadata
 */
export const scrapingInstructions = pgTable("scraping_instructions", {
  id: uuid("id").primaryKey().defaultRandom(),
  instructions: jsonb("instructions").$type<ScrapingInstructions>().notNull(),
  originalUrl: text("original_url").notNull(),
  originalSearch: text("original_search").notNull(),
  expectedOutputType: text("expected_output_type"), // Optional hint: "array" or "object"
  customPrompt: text("custom_prompt"), // Optional custom prompt text
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
  debugInfo: jsonb("debug_info").$type<Record<string, any>>(),
  testedAt: timestamp("tested_at").defaultNow().notNull(),
});

/**
 * Table for storing instruction snapshots/versions
 */
export const instructionSnapshots = pgTable("instruction_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  instructionId: uuid("instruction_id")
    .references(() => scrapingInstructions.id, { onDelete: "cascade" })
    .notNull(),
  version: integer("version").notNull(), // Version number (1, 2, 3, etc.)
  instructions: jsonb("instructions").$type<ScrapingInstructions>().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ScrapingInstruction = typeof scrapingInstructions.$inferSelect;
export type NewScrapingInstruction = typeof scrapingInstructions.$inferInsert;
export type ScrapeResult = typeof scrapeResults.$inferSelect;
export type NewScrapeResult = typeof scrapeResults.$inferInsert;
export type TestResult = typeof testResults.$inferSelect;
export type NewTestResult = typeof testResults.$inferInsert;
export type InstructionSnapshot = typeof instructionSnapshots.$inferSelect;
export type NewInstructionSnapshot = typeof instructionSnapshots.$inferInsert;
