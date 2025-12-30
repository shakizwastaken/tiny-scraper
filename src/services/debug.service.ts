import type {
  ExtractionDebugInfo,
  PaginationHints,
  RequestSelectionResult,
} from "../types/scraping";

/**
 * Log extraction debug information
 */
export function logExtractionDebugInfo(debugInfo: ExtractionDebugInfo): void {
  console.log("\n=== EXTRACTION DEBUG INFO ===");

  if (debugInfo.containerCount !== undefined) {
    console.log(`Container elements found: ${debugInfo.containerCount}`);
  }

  if (debugInfo.itemsExtracted !== undefined) {
    console.log(`Items extracted: ${debugInfo.itemsExtracted}`);
  }

  if (debugInfo.selectorMatches) {
    console.log("\nSelector match counts:");
    Object.entries(debugInfo.selectorMatches).forEach(([selector, count]) => {
      console.log(`  ${selector}: ${count} matches`);
    });
  }

  if (debugInfo.fieldExtractionStats) {
    console.log("\nField extraction statistics:");
    Object.entries(debugInfo.fieldExtractionStats).forEach(([field, stats]) => {
      const total = stats.success + stats.failed;
      const successRate =
        total > 0 ? ((stats.success / total) * 100).toFixed(1) : "0";
      const nullRate =
        total > 0 ? ((stats.nullCount / total) * 100).toFixed(1) : "0";
      console.log(
        `  ${field}: ${stats.success}/${total} success (${successRate}%), ${stats.nullCount} nulls (${nullRate}%)`
      );
    });
  }

  console.log("=== END EXTRACTION DEBUG ===\n");
}

/**
 * Log pagination debug information
 */
export function logPaginationDebugInfo(
  hints: PaginationHints,
  validationResult?: { tested: boolean; passed?: boolean; error?: string }
): void {
  console.log("\n=== PAGINATION DEBUG INFO ===");

  if (hints.detectedPattern) {
    console.log(`Detected pattern: ${hints.detectedPattern}`);
  } else {
    console.log("No pagination pattern detected");
  }

  if (hints.queryParams && Object.keys(hints.queryParams).length > 0) {
    console.log("URL query params:", JSON.stringify(hints.queryParams));
  }

  if (hints.bodyParams && Object.keys(hints.bodyParams).length > 0) {
    console.log(
      "Response pagination fields:",
      JSON.stringify(hints.bodyParams)
    );
  }

  if (hints.hasPaginationControls !== undefined) {
    console.log(
      `Pagination controls in HTML: ${
        hints.hasPaginationControls ? "Yes" : "No"
      }`
    );
  }

  if (hints.examples && hints.examples.length > 0) {
    console.log("Examples found:", hints.examples.join(", "));
  }

  if (validationResult) {
    console.log("\nPagination validation:");
    console.log(`  Tested: ${validationResult.tested}`);
    if (validationResult.passed !== undefined) {
      console.log(`  Passed: ${validationResult.passed}`);
    }
    if (validationResult.error) {
      console.log(`  Error: ${validationResult.error}`);
    }
  }

  console.log("=== END PAGINATION DEBUG ===\n");
}

/**
 * Log request selection debug information
 */
export function logRequestSelectionDebugInfo(
  result: RequestSelectionResult,
  totalMatches: number
): void {
  console.log("\n=== REQUEST SELECTION DEBUG INFO ===");
  console.log(`Total matches found: ${totalMatches}`);
  console.log(`Selected request index: ${result.selectedIndex}`);
  console.log(`Selection reasoning: ${result.reasoning}`);

  if (result.scores) {
    console.log("\nRequest scores:");
    Object.entries(result.scores).forEach(([index, scores]) => {
      console.log(`  Request #${index}:`);
      console.log(`    Data Quality: ${scores.dataQuality}`);
      console.log(`    Completeness: ${scores.completeness}`);
      console.log(`    Relevance: ${scores.relevance}`);
      console.log(`    Content Type: ${scores.contentType}`);
      console.log(`    Total Score: ${scores.total}`);
    });
  }

  console.log("=== END REQUEST SELECTION DEBUG ===\n");
}

/**
 * Generate a structured debug report
 */
export function generateDebugReport(data: {
  extraction?: ExtractionDebugInfo;
  pagination?: PaginationHints;
  paginationValidation?: { tested: boolean; passed?: boolean; error?: string };
  requestSelection?: RequestSelectionResult;
}): Record<string, any> {
  const report: Record<string, any> = {
    timestamp: new Date().toISOString(),
  };

  if (data.extraction) {
    report.extraction = data.extraction;
  }

  if (data.pagination) {
    report.pagination = data.pagination;
  }

  if (data.paginationValidation) {
    report.paginationValidation = data.paginationValidation;
  }

  if (data.requestSelection) {
    report.requestSelection = data.requestSelection;
  }

  return report;
}
