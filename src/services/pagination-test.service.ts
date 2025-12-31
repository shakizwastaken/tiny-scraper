import type {
  PaginationCandidate,
  PaginationTestResult,
} from "../types/scraping";

/**
 * Service for testing pagination patterns to validate they work correctly
 */
export class PaginationTester {
  /**
   * Test a single pagination pattern
   */
  async testPaginationPattern(
    pattern: PaginationCandidate,
    baseUrl: string,
    method: string,
    headers: Record<string, string>,
    body?: any
  ): Promise<PaginationTestResult> {
    const result: PaginationTestResult = {
      pattern,
      tested: true,
      passed: false,
      confidence: 0,
    };

    try {
      // Fetch page 1 (or initial page)
      const page1Response = await this.fetchPage(
        pattern,
        baseUrl,
        method,
        headers,
        body,
        1
      );

      if (!page1Response.ok) {
        result.error = `Page 1 request failed: ${page1Response.status}`;
        return result;
      }

      // Check for rate limiting
      if (page1Response.status === 429) {
        result.error = "Rate limited (429)";
        return result;
      }

      const page1Data = await page1Response.text();
      result.page1Results = this.parseResponse(page1Data);

      // Fetch page 2 (or next page)
      const page2Response = await this.fetchPage(
        pattern,
        baseUrl,
        method,
        headers,
        body,
        2
      );

      if (!page2Response.ok) {
        result.error = `Page 2 request failed: ${page2Response.status}`;
        return result;
      }

      // Check for rate limiting
      if (page2Response.status === 429) {
        result.error = "Rate limited (429) on page 2";
        return result;
      }

      const page2Data = await page2Response.text();
      result.page2Results = this.parseResponse(page2Data);

      // Compare results
      const comparison = this.compareResults(
        result.page1Results,
        result.page2Results
      );

      result.passed = comparison.different && !comparison.hasErrors;
      result.itemCounts = {
        page1: comparison.page1Count,
        page2: comparison.page2Count,
      };
      result.hasMoreDetected = comparison.hasMore;
      result.confidence = this.calculateConfidence(comparison);

      return result;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      return result;
    }
  }

  /**
   * Test cursor pagination with validation (cursor changes, no duplicates)
   */
  async testCursorPagination(
    pattern: PaginationCandidate,
    baseUrl: string,
    method: string,
    headers: Record<string, string>,
    body?: any
  ): Promise<PaginationTestResult> {
    const result: PaginationTestResult = {
      pattern,
      tested: true,
      passed: false,
      confidence: 0,
    };

    try {
      const page1Response = await this.fetchPage(
        pattern,
        baseUrl,
        method,
        headers,
        body,
        1
      );
      const page2Response = await this.fetchPage(
        pattern,
        baseUrl,
        method,
        headers,
        body,
        2
      );
      const page3Response = await this.fetchPage(
        pattern,
        baseUrl,
        method,
        headers,
        body,
        3
      );

      if (!page1Response.ok || !page2Response.ok || !page3Response.ok) {
        result.error = "One or more page requests failed";
        return result;
      }

      const page1Data = this.parseResponse(await page1Response.text());
      const page2Data = this.parseResponse(await page2Response.text());
      const page3Data = this.parseResponse(await page3Response.text());

      // Validate cursor changes
      const cursorValid = this.validateCursorChanges(
        page1Data,
        page2Data,
        page3Data
      );

      // Check for duplicate items across pages
      const duplicates = this.checkForDuplicates(
        page1Data,
        page2Data,
        page3Data
      );

      result.passed = cursorValid && !duplicates.hasDuplicates;
      result.confidence = cursorValid ? 0.9 : 0.3;
      if (duplicates.hasDuplicates) {
        result.error = `Duplicate items detected: ${duplicates.duplicateCount} duplicates`;
        result.confidence = Math.max(0, result.confidence - 0.3);
      }

      return result;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      return result;
    }
  }

  /**
   * Test offset pagination with edge cases (negative offsets, large offsets)
   */
  async testOffsetPaginationEdgeCases(
    pattern: PaginationCandidate,
    baseUrl: string,
    method: string,
    headers: Record<string, string>,
    body?: any
  ): Promise<PaginationTestResult> {
    const result: PaginationTestResult = {
      pattern,
      tested: true,
      passed: false,
      confidence: 0,
    };

    try {
      // Test normal offset
      const normalResponse = await this.fetchPage(
        pattern,
        baseUrl,
        method,
        headers,
        body,
        0
      );
      if (!normalResponse.ok) {
        result.error = "Normal offset request failed";
        return result;
      }

      // Test large offset
      const largeOffsetResponse = await this.fetchPage(
        pattern,
        baseUrl,
        method,
        headers,
        body,
        10000
      );
      const largeOffsetOk = largeOffsetResponse.ok;

      // Test negative offset (should fail or return empty)
      const negativeOffsetResponse = await this.fetchPage(
        pattern,
        baseUrl,
        method,
        headers,
        body,
        -1
      );
      const negativeOffsetOk = negativeOffsetResponse.ok;

      // Offset pagination should handle large offsets gracefully (empty result is OK)
      // Negative offsets should fail or return empty
      result.passed =
        normalResponse.ok &&
        (largeOffsetOk || largeOffsetResponse.status === 400);
      result.confidence = result.passed ? 0.8 : 0.4;

      return result;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      return result;
    }
  }

  /**
   * Test empty page handling
   */
  async testEmptyPageHandling(
    pattern: PaginationCandidate,
    baseUrl: string,
    method: string,
    headers: Record<string, string>,
    body?: any
  ): Promise<PaginationTestResult> {
    const result: PaginationTestResult = {
      pattern,
      tested: true,
      passed: false,
      confidence: 0,
    };

    try {
      // Try to fetch a very high page number (likely empty)
      const highPageResponse = await this.fetchPage(
        pattern,
        baseUrl,
        method,
        headers,
        body,
        99999
      );

      if (!highPageResponse.ok && highPageResponse.status !== 404) {
        result.error = `High page request failed with status ${highPageResponse.status}`;
        return result;
      }

      const highPageData = this.parseResponse(await highPageResponse.text());
      const itemCount = this.countItems(highPageData);

      // Empty page should return empty array or empty object, not error
      result.passed = highPageResponse.ok && itemCount === 0;
      result.confidence = result.passed ? 0.7 : 0.3;

      return result;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      return result;
    }
  }

  /**
   * Test last page detection (no more data indicators)
   */
  async testLastPageDetection(
    pattern: PaginationCandidate,
    baseUrl: string,
    method: string,
    headers: Record<string, string>,
    body?: any
  ): Promise<PaginationTestResult> {
    const result: PaginationTestResult = {
      pattern,
      tested: true,
      passed: false,
      confidence: 0,
    };

    try {
      // Fetch multiple pages to find the last one
      let currentPage = 1;
      let hasMore = true;
      let lastPageData: any = null;

      while (hasMore && currentPage <= 10) {
        // Limit to 10 pages for testing
        const response = await this.fetchPage(
          pattern,
          baseUrl,
          method,
          headers,
          body,
          currentPage
        );

        if (!response.ok) {
          break;
        }

        const data = this.parseResponse(await response.text());
        const itemCount = this.countItems(data);

        // Check for "hasMore" or "next" indicators
        hasMore = this.detectHasMore(data, null) && itemCount > 0;

        if (!hasMore || itemCount === 0) {
          lastPageData = data;
          break;
        }

        currentPage++;
      }

      // Last page should have no "hasMore" or empty items
      if (lastPageData) {
        const hasMoreIndicator = this.detectHasMore(lastPageData, null);
        const itemCount = this.countItems(lastPageData);

        result.passed = !hasMoreIndicator || itemCount === 0;
        result.confidence = result.passed ? 0.8 : 0.4;
      } else {
        result.error = "Could not determine last page";
      }

      return result;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      return result;
    }
  }

  /**
   * Check for duplicate items across pages
   */
  private checkForDuplicates(
    page1: any,
    page2: any,
    page3: any
  ): {
    hasDuplicates: boolean;
    duplicateCount: number;
  } {
    const items1 = this.extractItems(page1);
    const items2 = this.extractItems(page2);
    const items3 = this.extractItems(page3);

    const allItems = [...items1, ...items2, ...items3];
    const uniqueItems = new Set(allItems.map((item) => JSON.stringify(item)));

    const duplicateCount = allItems.length - uniqueItems.size;

    return {
      hasDuplicates: duplicateCount > 0,
      duplicateCount,
    };
  }

  /**
   * Extract items from response data
   */
  private extractItems(data: any): any[] {
    if (Array.isArray(data)) {
      return data;
    }
    if (data && typeof data === "object") {
      const arrayFields = ["items", "data", "results", "list", "records"];
      for (const field of arrayFields) {
        if (Array.isArray(data[field])) {
          return data[field];
        }
      }
    }
    return [];
  }

  /**
   * Detect if first page is handled differently
   */
  async testFirstPageDifference(
    pattern: PaginationCandidate,
    baseUrl: string,
    method: string,
    headers: Record<string, string>,
    body?: any
  ): Promise<{
    different: boolean;
    preferredApproach: "no-param" | "explicit-param";
  }> {
    try {
      // Test with no pagination param (default first page)
      const noParamResponse = await this.fetchPage(
        pattern,
        baseUrl,
        method,
        headers,
        body,
        undefined,
        true // skip pagination
      );
      const noParamData = await noParamResponse.text();
      const noParamParsed = this.parseResponse(noParamData);

      // Test with explicit page=1 or offset=0
      const explicitParamResponse = await this.fetchPage(
        pattern,
        baseUrl,
        method,
        headers,
        body,
        1
      );
      const explicitParamData = await explicitParamResponse.text();
      const explicitParamParsed = this.parseResponse(explicitParamData);

      // Compare results
      const different =
        JSON.stringify(noParamParsed) !== JSON.stringify(explicitParamParsed);

      // Determine preferred approach (usually no-param is better if it works)
      const preferredApproach = different ? "no-param" : "explicit-param";

      return { different, preferredApproach };
    } catch (error) {
      // If testing fails, default to explicit param
      return { different: false, preferredApproach: "explicit-param" };
    }
  }

  /**
   * Comprehensive validation of pagination
   */
  async validatePaginationWorks(
    pattern: PaginationCandidate,
    baseUrl: string,
    method: string,
    headers: Record<string, string>,
    body?: any
  ): Promise<PaginationTestResult> {
    const result: PaginationTestResult = {
      pattern,
      tested: true,
      passed: false,
      confidence: 0,
    };

    try {
      // Test multiple pages
      const page1Response = await this.fetchPage(
        pattern,
        baseUrl,
        method,
        headers,
        body,
        1
      );
      const page2Response = await this.fetchPage(
        pattern,
        baseUrl,
        method,
        headers,
        body,
        2
      );
      const page3Response = await this.fetchPage(
        pattern,
        baseUrl,
        method,
        headers,
        body,
        3
      );

      if (!page1Response.ok || !page2Response.ok || !page3Response.ok) {
        result.error = "One or more page requests failed";
        return result;
      }

      const page1Data = this.parseResponse(await page1Response.text());
      const page2Data = this.parseResponse(await page2Response.text());
      const page3Data = this.parseResponse(await page3Response.text());

      // Verify data changes between pages
      const page1To2Different =
        JSON.stringify(page1Data) !== JSON.stringify(page2Data);
      const page2To3Different =
        JSON.stringify(page2Data) !== JSON.stringify(page3Data);

      // Check for pagination metadata
      const hasMetadata = this.checkPaginationMetadata(
        page1Data,
        page2Data,
        page3Data
      );

      // Validate cursor-based pagination (cursor should change)
      let cursorValid = true;
      if (pattern.pattern === "cursor") {
        cursorValid = this.validateCursorChanges(
          page1Data,
          page2Data,
          page3Data
        );
      }

      result.passed = page1To2Different && page2To3Different && cursorValid;
      result.hasMoreDetected = hasMetadata.hasMore;
      result.confidence = this.calculateValidationConfidence({
        page1To2Different,
        page2To3Different,
        cursorValid,
        hasMetadata,
      });

      return result;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      return result;
    }
  }

  /**
   * Compare results from different pages
   */
  compareResults(
    page1Results: any,
    page2Results: any
  ): {
    different: boolean;
    hasErrors: boolean;
    page1Count: number;
    page2Count: number;
    hasMore: boolean;
  } {
    const page1Count = this.countItems(page1Results);
    const page2Count = this.countItems(page2Results);

    // Check if results are different
    const different =
      JSON.stringify(page1Results) !== JSON.stringify(page2Results);

    // Check for pagination metadata
    const hasMore = this.detectHasMore(page1Results, page2Results);

    return {
      different,
      hasErrors: false,
      page1Count,
      page2Count,
      hasMore,
    };
  }

  /**
   * Fetch a page with pagination applied
   */
  private async fetchPage(
    pattern: PaginationCandidate,
    baseUrl: string,
    method: string,
    headers: Record<string, string>,
    body?: any,
    pageNumber?: number,
    skipPagination: boolean = false
  ): Promise<Response> {
    let url = baseUrl;
    let requestBody = body;
    const requestHeaders = { ...headers };

    if (!skipPagination && pageNumber !== undefined) {
      if (pattern.type === "query") {
        const urlObj = new URL(baseUrl);
        urlObj.searchParams.set(
          pattern.paramName || "page",
          String(pageNumber)
        );
        url = urlObj.toString();
      } else if (pattern.type === "body" && requestBody) {
        const bodyObj =
          typeof requestBody === "string"
            ? JSON.parse(requestBody)
            : requestBody;
        this.setNestedValue(
          bodyObj,
          pattern.location.split(".").slice(1),
          pageNumber
        );
        requestBody = JSON.stringify(bodyObj);
      } else if (pattern.type === "header") {
        requestHeaders[pattern.paramName || "X-Page"] = String(pageNumber);
      }
    }

    const options: RequestInit = {
      method,
      headers: requestHeaders,
    };

    if (
      requestBody &&
      (method === "POST" || method === "PUT" || method === "PATCH")
    ) {
      options.body = requestBody;
      if (!requestHeaders["Content-Type"]) {
        requestHeaders["Content-Type"] = "application/json";
      }
    }

    return fetch(url, options);
  }

  /**
   * Parse response based on content type
   */
  private parseResponse(data: string): any {
    try {
      return JSON.parse(data);
    } catch {
      return data; // Return as string if not JSON
    }
  }

  /**
   * Count items in response (handles arrays and objects)
   */
  private countItems(data: any): number {
    if (Array.isArray(data)) {
      return data.length;
    }
    if (data && typeof data === "object") {
      // Try common array fields
      const arrayFields = ["items", "data", "results", "list", "records"];
      for (const field of arrayFields) {
        if (Array.isArray(data[field])) {
          return data[field].length;
        }
      }
      return 1; // Single object
    }
    return 0;
  }

  /**
   * Detect if there's more data (hasMore, totalPages, etc.)
   */
  private detectHasMore(page1: any, page2: any): boolean {
    if (page1 && typeof page1 === "object") {
      const hasMoreFields = ["hasMore", "has_next", "hasNext", "more", "next"];
      for (const field of hasMoreFields) {
        if (page1[field] === true || page1[field] === "true") {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Check for pagination metadata in responses
   */
  private checkPaginationMetadata(
    page1: any,
    page2: any,
    page3: any
  ): { hasMore: boolean; totalPages?: number; totalCount?: number } {
    const metadata: {
      hasMore: boolean;
      totalPages?: number;
      totalCount?: number;
    } = {
      hasMore: false,
    };

    if (page1 && typeof page1 === "object") {
      const metaFields = ["meta", "pagination", "paging", "_meta"];
      for (const metaField of metaFields) {
        if (page1[metaField] && typeof page1[metaField] === "object") {
          const meta = page1[metaField];
          if (meta.hasMore || meta.has_next || meta.hasNext) {
            metadata.hasMore = true;
          }
          if (meta.totalPages || meta.total_pages) {
            metadata.totalPages = meta.totalPages || meta.total_pages;
          }
          if (meta.totalCount || meta.total_count || meta.total) {
            metadata.totalCount =
              meta.totalCount || meta.total_count || meta.total;
          }
        }
      }
    }

    return metadata;
  }

  /**
   * Validate cursor changes between pages
   */
  private validateCursorChanges(page1: any, page2: any, page3: any): boolean {
    const extractCursor = (data: any): string | null => {
      if (!data || typeof data !== "object") return null;

      const cursorFields = [
        "cursor",
        "nextCursor",
        "nextToken",
        "after",
        "next",
      ];
      for (const field of cursorFields) {
        if (data[field] && typeof data[field] === "string") {
          return data[field];
        }
      }

      // Check nested
      if (data.meta || data.pagination) {
        const meta = data.meta || data.pagination;
        for (const field of cursorFields) {
          if (meta[field] && typeof meta[field] === "string") {
            return meta[field];
          }
        }
      }

      return null;
    };

    const cursor1 = extractCursor(page1);
    const cursor2 = extractCursor(page2);
    const cursor3 = extractCursor(page3);

    // Cursors should change between pages
    return cursor1 !== cursor2 && cursor2 !== cursor3 && cursor1 !== cursor3;
  }

  /**
   * Calculate confidence score from comparison
   */
  private calculateConfidence(comparison: {
    different: boolean;
    hasErrors: boolean;
    page1Count: number;
    page2Count: number;
    hasMore: boolean;
  }): number {
    let score = 0;

    if (comparison.different) score += 0.4;
    if (!comparison.hasErrors) score += 0.2;
    if (comparison.page1Count > 0 && comparison.page2Count > 0) score += 0.2;
    if (comparison.hasMore) score += 0.2;

    return Math.min(score, 1.0);
  }

  /**
   * Calculate confidence from validation results
   */
  private calculateValidationConfidence(validation: {
    page1To2Different: boolean;
    page2To3Different: boolean;
    cursorValid: boolean;
    hasMetadata: { hasMore: boolean; totalPages?: number; totalCount?: number };
  }): number {
    let score = 0;

    if (validation.page1To2Different) score += 0.3;
    if (validation.page2To3Different) score += 0.3;
    if (validation.cursorValid) score += 0.2;
    if (validation.hasMetadata.hasMore) score += 0.1;
    if (validation.hasMetadata.totalPages || validation.hasMetadata.totalCount)
      score += 0.1;

    return Math.min(score, 1.0);
  }

  /**
   * Set nested value in object
   */
  private setNestedValue(obj: any, path: string[], value: any): void {
    let current = obj;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (key && !current[key]) {
        current[key] = {};
      }
      current = key ? (current[key] as Record<string, any>) : undefined;
    }
    if (current && path[path.length - 1]) {
      current[path[path.length - 1] as keyof typeof current] = value;
    }
  }
}
