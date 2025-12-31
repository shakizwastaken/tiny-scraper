import type { Page } from "puppeteer";
import OpenAI from "openai";
import {
  detectPaginationFromUrl,
  detectPaginationFromHTML,
  detectPaginationFromJSON,
  detectPaginationFromHeaders,
  detectPaginationFromBody,
  detectPaginationFromResponseMetadata,
  type PaginationHints,
} from "../utils/pagination-detector";
import { PaginationTester } from "./pagination-test.service";
import { PaginationLLMService } from "./pagination-llm.service";
import type {
  PaginationCandidate,
  PaginationAnalysisResult,
  PaginationTestResult,
  PaginationContext,
} from "../types/scraping";

/**
 * Comprehensive pagination analyzer that orchestrates all detection and testing
 */
export class PaginationAnalyzer {
  private tester: PaginationTester;
  private llmService: PaginationLLMService;

  constructor(openai: OpenAI | null = null) {
    this.tester = new PaginationTester();
    this.llmService = new PaginationLLMService(openai);
  }

  /**
   * Analyze all pagination types from various sources
   */
  async analyzeAllPaginationTypes(
    requestUrl: string,
    method: string,
    headers: Record<string, string>,
    body: any,
    responseBody: string,
    responseType: "json" | "html",
    responseHeaders: Record<string, string> = {},
    page?: Page
  ): Promise<PaginationAnalysisResult> {
    const candidates: PaginationCandidate[] = [];
    const allHints: PaginationHints = {
      queryParams: {},
      bodyParams: {},
    };

    // 1. URL Detection (rule-based, no LLM)
    const urlHints = detectPaginationFromUrl(requestUrl);
    if (urlHints.detectedPattern && urlHints.detectedPattern !== "none") {
      const urlCandidate = this.createCandidateFromUrlHints(
        urlHints,
        requestUrl
      );
      if (urlCandidate) {
        candidates.push(urlCandidate);
      }
    }
    Object.assign(allHints, urlHints);

    // 2. Response Detection (rule-based first, LLM for ambiguous)
    let responseHints: PaginationHints = {};
    try {
      if (responseType === "json") {
        const json = JSON.parse(responseBody);
        responseHints = detectPaginationFromJSON(json);
      } else {
        responseHints = detectPaginationFromHTML(responseBody);
      }

      if (
        responseHints.detectedPattern &&
        responseHints.detectedPattern !== "none"
      ) {
        const responseCandidate = this.createCandidateFromResponseHints(
          responseHints,
          responseType
        );
        if (responseCandidate) {
          candidates.push(responseCandidate);
        }
      }
      Object.assign(allHints, responseHints);
    } catch (e) {
      console.warn("Response detection error:", e);
    }

    // 3. Header Detection (rule-based, no LLM)
    const headerHints = detectPaginationFromHeaders(responseHeaders);
    if (headerHints.detectedPattern && headerHints.detectedPattern !== "none") {
      const headerCandidate = this.createCandidateFromHeaderHints(headerHints);
      if (headerCandidate) {
        candidates.push(headerCandidate);
      }
    }
    Object.assign(allHints, headerHints);

    // 4. Body Detection (rule-based first, LLM for complex nested)
    if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      const bodyHints = detectPaginationFromBody(body);
      if (bodyHints.detectedPattern && bodyHints.detectedPattern !== "none") {
        const bodyCandidate = this.createCandidateFromBodyHints(bodyHints);
        if (bodyCandidate) {
          candidates.push(bodyCandidate);
        }
      }
      Object.assign(allHints, bodyHints);
    }

    // 5. UI Detection (if page available)
    if (page) {
      const uiCandidates = await this.detectPaginationFromUI(page, requestUrl);
      candidates.push(...uiCandidates);
    }

    // 6. Network Detection (analyze intercepted requests)
    // This would be handled by the caller who has access to intercepted requests

    // Test all candidates
    const testResults: PaginationTestResult[] = [];
    const baseUrl = requestUrl.split("?")[0];

    for (const candidate of candidates) {
      try {
        if (!baseUrl) continue;
        const testResult = await this.tester.testPaginationPattern(
          candidate,
          baseUrl,
          method,
          headers,
          body
        );
        candidate.testResults = testResult;
        testResults.push(testResult);
      } catch (error) {
        console.warn(`Failed to test candidate ${candidate.location}:`, error);
      }
    }

    // Rank candidates
    const rankedCandidates = await this.rankPaginationCandidates(
      candidates,
      testResults,
      {
        url: requestUrl,
        method,
        responseType,
        headers,
        body,
      }
    );

    // Determine best candidate
    const bestCandidate =
      rankedCandidates.length > 0 && rankedCandidates[0]
        ? rankedCandidates[0].candidate
        : undefined;

    // Test first page differences if we have a best candidate
    let firstPageBehavior;
    if (bestCandidate && baseUrl) {
      try {
        const firstPageTest = await this.tester.testFirstPageDifference(
          bestCandidate,
          baseUrl,
          method,
          headers,
          body
        );
        firstPageBehavior = firstPageTest;
      } catch (error) {
        console.warn("First page difference test failed:", error);
      }
    }

    return {
      candidates: rankedCandidates.map((r) => r.candidate),
      bestCandidate,
      allHints,
      testResults,
      firstPageBehavior,
    };
  }

  /**
   * Rank pagination candidates by confidence and test results
   */
  private async rankPaginationCandidates(
    candidates: PaginationCandidate[],
    testResults: PaginationTestResult[],
    context: PaginationContext
  ): Promise<
    Array<{ candidate: PaginationCandidate; rank: number; reasoning: string }>
  > {
    // Enhanced rule-based scoring with multiple factors
    const scoredCandidates = candidates.map((candidate) => {
      const testResult = testResults.find((tr) => tr.pattern === candidate);
      let score = candidate.confidence;

      // Boost score based on test results (40% weight)
      if (testResult) {
        if (testResult.passed) {
          score += 0.3;
        }
        score += testResult.confidence * 0.2;

        // Additional boost for comprehensive tests
        if (
          testResult.itemCounts &&
          testResult.itemCounts.page1 > 0 &&
          testResult.itemCounts.page2 > 0
        ) {
          score += 0.1;
        }
        if (testResult.hasMoreDetected) {
          score += 0.05;
        }
      }

      // Boost score based on completeness (10% weight)
      if (candidate.paramName && candidate.location) {
        score += 0.1;
      }

      // Boost score based on pattern type (some patterns are more reliable)
      if (candidate.pattern === "page") {
        score += 0.05; // Page-based is most common and reliable
      } else if (candidate.pattern === "cursor") {
        score += 0.03; // Cursor-based is reliable but less common
      }

      // Boost score based on type (query params are most reliable)
      if (candidate.type === "query") {
        score += 0.05;
      } else if (candidate.type === "body") {
        score += 0.03;
      }

      // Boost score if examples are provided
      if (candidate.examples && candidate.examples.length > 0) {
        score += 0.02;
      }

      // Penalize UI-based pagination (less reliable)
      if (candidate.type === "ui") {
        score -= 0.1;
      }

      return {
        candidate: {
          ...candidate,
          confidence: Math.min(Math.max(score, 0), 1.0),
        },
        originalScore: candidate.confidence,
        testScore: testResult?.confidence || 0,
        passed: testResult?.passed || false,
        itemCounts: testResult?.itemCounts,
      };
    });

    // Sort by score
    scoredCandidates.sort(
      (a, b) => b.candidate.confidence - a.candidate.confidence
    );

    // Check if scores are very close (within 0.1) - use LLM if needed
    const topScore = scoredCandidates[0]?.candidate.confidence || 0;
    const closeScores = scoredCandidates.filter(
      (sc) => Math.abs(sc.candidate.confidence - topScore) < 0.1
    );

    if (closeScores.length > 1) {
      // Use LLM to break ties
      const llmRanked = await this.llmService.rankCandidates(
        closeScores.map((sc) => sc.candidate),
        testResults.filter((tr) =>
          closeScores.some((sc) => sc.candidate === tr.pattern)
        ),
        JSON.stringify(context)
      );

      // Merge LLM rankings with rule-based
      return llmRanked.map((lr) => ({
        candidate: lr.candidate,
        rank: lr.rank,
        reasoning: lr.reasoning,
      }));
    }

    // Return rule-based ranking
    return scoredCandidates.map((sc, i) => ({
      candidate: sc.candidate,
      rank: i + 1,
      reasoning: `Rule-based: confidence ${sc.candidate.confidence.toFixed(
        2
      )}, test ${sc.testScore.toFixed(2)}`,
    }));
  }

  /**
   * Detect pagination from UI elements using Puppeteer
   */
  private async detectPaginationFromUI(
    page: Page,
    baseUrl: string
  ): Promise<PaginationCandidate[]> {
    const candidates: PaginationCandidate[] = [];

    try {
      // Find pagination buttons/links with enhanced detection
      const buttons = await page.$$eval(
        'button, a, [role="button"], [data-page], [data-next], [data-pagination]',
        (elements) => {
          return elements
            .map((el) => {
              const text = el.textContent?.toLowerCase() || "";
              const className = el.className || "";
              const id = el.id || "";
              const ariaLabel =
                el.getAttribute("aria-label")?.toLowerCase() || "";
              const dataAttrs: Record<string, string> = {};

              // Extract data attributes
              for (let i = 0; i < el.attributes.length; i++) {
                const attr = el.attributes[i];
                if (
                  attr &&
                  attr.name.startsWith("data-") &&
                  typeof attr.value === "string"
                ) {
                  dataAttrs[attr.name] = attr.value;
                }
              }

              const paginationKeywords = [
                "load more",
                "next",
                "show more",
                "more",
                "page",
                "pagination",
                "prev",
                "previous",
                "first",
                "last",
                "scroll",
                "infinite",
              ];

              const hasPaginationKeyword =
                paginationKeywords.some(
                  (kw) =>
                    text.includes(kw) ||
                    className.toLowerCase().includes(kw) ||
                    ariaLabel.includes(kw)
                ) ||
                Object.keys(dataAttrs).some((key) =>
                  paginationKeywords.some((kw) => key.includes(kw))
                ) ||
                // Check for pagination data attributes
                el.hasAttribute("data-page") ||
                el.hasAttribute("data-next") ||
                el.hasAttribute("data-pagination") ||
                el.hasAttribute("data-page-number");

              if (hasPaginationKeyword) {
                return {
                  selector:
                    el.tagName.toLowerCase() +
                    (el.id ? `#${el.id}` : "") +
                    (className ? `.${className.split(" ")[0]}` : ""),
                  text,
                  href:
                    (el.tagName.toLowerCase() === "a" && "href" in el
                      ? (el as { href?: string }).href
                      : "") || "",
                  onClick: el.getAttribute("onclick") || "",
                  dataAttrs,
                  className,
                  id,
                };
              }
              return null;
            })
            .filter((item): item is NonNullable<typeof item> => item !== null);
        }
      );

      // Detect infinite scroll containers
      const scrollContainers = await page
        .$$eval(
          '[data-infinite-scroll], [data-lazy-load], .infinite-scroll, .lazy-load, [class*="scroll"]',
          (elements) => {
            return elements.map((el) => ({
              selector:
                el.tagName.toLowerCase() +
                (el.id ? `#${el.id}` : "") +
                (el.className ? `.${el.className.split(" ")[0]}` : ""),
              className: el.className || "",
              id: el.id || "",
              hasScrollListener: false, // Would need to check event listeners
            }));
          }
        )
        .catch(() => []);

      for (const button of buttons) {
        // Try to extract pagination info from button
        if (button.href) {
          try {
            const url = new URL(button.href);
            const pageParam =
              url.searchParams.get("page") || url.searchParams.get("p");
            const offsetParam = url.searchParams.get("offset");
            const cursorParam =
              url.searchParams.get("cursor") || url.searchParams.get("after");

            if (pageParam) {
              candidates.push({
                type: "ui",
                location: `ui.link.${button.selector}`,
                paramName: "page",
                pattern: "page",
                confidence: 0.8,
                examples: [button.href],
              });
            } else if (offsetParam) {
              candidates.push({
                type: "ui",
                location: `ui.link.${button.selector}`,
                paramName: "offset",
                pattern: "offset",
                confidence: 0.75,
                examples: [button.href],
              });
            } else if (cursorParam) {
              candidates.push({
                type: "ui",
                location: `ui.link.${button.selector}`,
                paramName: "cursor",
                pattern: "cursor",
                confidence: 0.75,
                examples: [button.href],
              });
            }
          } catch (e) {
            // Invalid URL, try relative URL
            if (button.href.startsWith("/") || button.href.startsWith("?")) {
              const urlMatch = button.href.match(
                /[?&](page|offset|cursor|after)=([^&]+)/
              );
              if (urlMatch) {
                candidates.push({
                  type: "ui",
                  location: `ui.link.${button.selector}`,
                  paramName: urlMatch[1],
                  pattern:
                    urlMatch[1] === "page"
                      ? "page"
                      : urlMatch[1] === "offset"
                      ? "offset"
                      : "cursor",
                  confidence: 0.7,
                  examples: [button.href],
                });
              }
            }
          }
        }

        // Check data attributes with more patterns
        if (
          button.dataAttrs["data-page"] ||
          button.dataAttrs["data-next-page"] ||
          button.dataAttrs["data-page-number"]
        ) {
          candidates.push({
            type: "ui",
            location: `ui.button.${button.selector}`,
            paramName: "page",
            pattern: "page",
            confidence: 0.7,
            examples: [JSON.stringify(button.dataAttrs)],
          });
        }

        // Check for load more buttons
        if (
          button.text.includes("load more") ||
          button.text.includes("show more")
        ) {
          candidates.push({
            type: "ui",
            location: `ui.button.${button.selector}`,
            pattern: "scroll",
            confidence: 0.6,
            examples: [button.text],
          });
        }
      }

      // Add infinite scroll candidates
      for (const container of scrollContainers) {
        candidates.push({
          type: "scroll",
          location: `ui.scroll.${container.selector}`,
          pattern: "scroll",
          confidence: 0.65,
          examples: [container.className],
        });
      }
    } catch (error) {
      console.warn("UI detection failed:", error);
    }

    return candidates;
  }

  /**
   * Create candidate from URL hints
   */
  private createCandidateFromUrlHints(
    hints: PaginationHints,
    url: string
  ): PaginationCandidate | null {
    if (!hints.queryParams || Object.keys(hints.queryParams).length === 0) {
      return null;
    }

    const paramName = Object.keys(hints.queryParams)[0];
    return {
      type: "query",
      location: `query.${paramName}`,
      paramName,
      pattern: (hints.detectedPattern && hints.detectedPattern !== "none"
        ? hints.detectedPattern
        : "page") as "page" | "offset" | "cursor",
      confidence: 0.8,
      examples: Object.entries(hints.queryParams).map(([k, v]) => `${k}=${v}`),
      initialValue:
        hints.detectedPattern === "page"
          ? 1
          : hints.detectedPattern === "offset"
          ? 0
          : undefined,
    };
  }

  /**
   * Create candidate from response hints
   */
  private createCandidateFromResponseHints(
    hints: PaginationHints,
    responseType: "json" | "html"
  ): PaginationCandidate | null {
    if (responseType === "json" && hints.bodyParams) {
      const firstKey = Object.keys(hints.bodyParams)[0];
      if (firstKey) {
        return {
          type: "response",
          location: `response.${firstKey}`,
          paramName: firstKey.split(".").pop(),
          pattern: (hints.detectedPattern && hints.detectedPattern !== "none"
            ? hints.detectedPattern
            : "page") as "page" | "offset" | "cursor",
          confidence: 0.7,
          examples: [firstKey],
        };
      }
    }

    if (hints.hasPaginationControls) {
      return {
        type: "ui",
        location: "ui.controls",
        pattern: (hints.detectedPattern && hints.detectedPattern !== "none"
          ? hints.detectedPattern
          : "page") as "page" | "offset" | "cursor",
        confidence: 0.5,
      };
    }

    return null;
  }

  /**
   * Create candidate from header hints
   */
  private createCandidateFromHeaderHints(
    hints: PaginationHints
  ): PaginationCandidate | null {
    if (!hints.examples || hints.examples.length === 0) {
      return null;
    }

    // Extract header name from examples
    const headerExample = hints.examples[0];
    if (!headerExample) return null;
    const headerMatch = headerExample.match(/^([^:]+):/);
    if (headerMatch && headerMatch[1]) {
      return {
        type: "header",
        location: `header.${headerMatch[1]}`,
        paramName: headerMatch[1],
        pattern: (hints.detectedPattern && hints.detectedPattern !== "none"
          ? hints.detectedPattern
          : "page") as "page" | "offset" | "cursor",
        confidence: 0.6,
        examples: hints.examples,
      };
    }

    return null;
  }

  /**
   * Create candidate from body hints
   */
  private createCandidateFromBodyHints(
    hints: PaginationHints
  ): PaginationCandidate | null {
    if (!hints.bodyParams || Object.keys(hints.bodyParams).length === 0) {
      return null;
    }

    const firstKey = Object.keys(hints.bodyParams)[0];
    if (!firstKey) return null;
    const pathParts = firstKey.split(".");
    const lastPart = pathParts[pathParts.length - 1];
    if (!lastPart) return null;
    return {
      type: "body",
      location: `body.${firstKey}`,
      paramName: lastPart,
      pattern: (hints.detectedPattern && hints.detectedPattern !== "none"
        ? hints.detectedPattern
        : "page") as "page" | "offset" | "cursor",
      confidence: 0.7,
      examples: [firstKey],
      initialValue:
        hints.detectedPattern === "page"
          ? 1
          : hints.detectedPattern === "offset"
          ? 0
          : undefined,
    };
  }

  /**
   * Generate pagination instructions from best candidate
   */
  generatePaginationInstructions(candidate: PaginationCandidate): {
    type: "query" | "body" | "header" | "response";
    location: string;
    placeholder: string;
    initialValue?: string | number;
  } | null {
    if (!candidate) {
      return null;
    }

    let placeholder = "{{page}}";
    if (candidate.pattern === "offset") {
      placeholder = "{{offset}}";
    } else if (candidate.pattern === "cursor") {
      placeholder = "{{cursor}}";
    }

    return {
      type: candidate.type as "query" | "body" | "header" | "response",
      location: candidate.location,
      placeholder,
      initialValue: candidate.initialValue,
    };
  }
}
