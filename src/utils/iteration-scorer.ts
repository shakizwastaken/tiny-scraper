import type {
  TestResults,
  ScrapingInstructions,
  IterationRecord,
} from "../types/scraping";

/**
 * Calculate a score for a test result to compare iterations
 * Higher score = better iteration
 */
export function calculateIterationScore(testResults: TestResults): number {
  let score = 0;

  // Success flag: +1000 if true, 0 if false (highest priority)
  if (testResults.success) {
    score += 1000;
  }

  // Error count: -10 per error
  if (testResults.errors && testResults.errors.length > 0) {
    score -= testResults.errors.length * 10;
  }

  // Total items extracted: +1 per item (max +100)
  if (testResults.debugInfo?.totalItems !== undefined) {
    const totalItems = Number(testResults.debugInfo.totalItems);
    if (!isNaN(totalItems) && totalItems > 0) {
      score += Math.min(totalItems, 100);
    }
  }

  // Pagination test passed: +50 if passed (when pagination is configured)
  if (
    testResults.paginationTestResult?.tested &&
    testResults.paginationTestResult.passed === true
  ) {
    score += 50;
  }

  return score;
}

/**
 * Compare two iterations for sorting
 * Returns negative if a < b, positive if a > b, 0 if equal
 */
export function compareIterations(
  a: IterationRecord,
  b: IterationRecord
): number {
  const scoreA = calculateIterationScore(a.testResults);
  const scoreB = calculateIterationScore(b.testResults);

  // First compare by score (higher is better)
  if (scoreA !== scoreB) {
    return scoreB - scoreA; // Descending order
  }

  // If scores are equal, prefer earlier iteration (faster to reach)
  if (a.iteration !== b.iteration) {
    return a.iteration - b.iteration;
  }

  // If still equal, prefer fewer errors
  const errorsA = a.testResults.errors?.length || 0;
  const errorsB = b.testResults.errors?.length || 0;
  if (errorsA !== errorsB) {
    return errorsA - errorsB;
  }

  // If still equal, prefer more items extracted
  const itemsA = Number(a.testResults.debugInfo?.totalItems) || 0;
  const itemsB = Number(b.testResults.debugInfo?.totalItems) || 0;
  if (itemsA !== itemsB) {
    return itemsB - itemsA; // More items is better
  }

  return 0;
}
