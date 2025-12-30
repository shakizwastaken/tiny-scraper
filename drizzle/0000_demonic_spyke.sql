CREATE TABLE "scrape_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instruction_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"pagination" jsonb,
	"executed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scraping_instructions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instructions" jsonb NOT NULL,
	"original_url" text NOT NULL,
	"original_search" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instruction_id" uuid NOT NULL,
	"success" boolean NOT NULL,
	"extracted_data" jsonb,
	"errors" jsonb,
	"schema_validation_errors" jsonb,
	"required_fields_missing" jsonb,
	"debug_info" jsonb,
	"tested_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scrape_results" ADD CONSTRAINT "scrape_results_instruction_id_scraping_instructions_id_fk" FOREIGN KEY ("instruction_id") REFERENCES "public"."scraping_instructions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_instruction_id_scraping_instructions_id_fk" FOREIGN KEY ("instruction_id") REFERENCES "public"."scraping_instructions"("id") ON DELETE cascade ON UPDATE no action;