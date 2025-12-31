import OpenAI from "openai";
import type {
  PaginationCandidate,
  PaginationTestResult,
  PaginationContext,
} from "../types/scraping";

interface PaginationPattern {
  type: "query" | "body" | "header" | "response" | "ui";
  location: string;
  paramName?: string;
  pattern: "page" | "offset" | "cursor";
}

interface FirstPageAnalysis {
  different: boolean;
  preferredApproach: "no-param" | "explicit-param";
  reasoning: string;
}

interface RankedCandidate {
  candidate: PaginationCandidate;
  rank: number;
  reasoning: string;
}

/**
 * Service for using LLMs to analyze complex pagination patterns
 * Uses LLMs strategically only when rule-based methods are insufficient
 */
export class PaginationLLMService {
  private cache: Map<string, any> = new Map();
  private openai: OpenAI | null;

  constructor(openai: OpenAI | null) {
    this.openai = openai;
  }

  /**
   * Analyze ambiguous pagination patterns when multiple candidates exist
   */
  async analyzeAmbiguousPatterns(
    candidates: PaginationCandidate[],
    context: PaginationContext
  ): Promise<PaginationCandidate[]> {
    if (!this.openai || candidates.length <= 1) {
      return candidates;
    }

    // Check cache
    const cacheKey = `ambiguous_${this.hashCandidates(
      candidates
    )}_${this.hashContext(context)}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      const prompt = this.buildAmbiguousPatternsPrompt(candidates, context);
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini", // Use cheaper model for analysis
        messages: [
          {
            role: "system",
            content:
              "You are a pagination detection expert. Analyze pagination patterns and rank them by likelihood of being correct.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      const result = this.parseAmbiguousResponse(
        response.choices[0]?.message?.content || ""
      );
      this.cache.set(cacheKey, result);
      return result;
    } catch (error) {
      console.warn(
        "LLM analysis failed, returning original candidates:",
        error
      );
      return candidates;
    }
  }

  /**
   * Understand JavaScript pagination code
   */
  async analyzeJavaScriptPagination(
    codeSnippet: string,
    context: string
  ): Promise<PaginationPattern | null> {
    if (!this.openai) {
      return null;
    }

    // Check cache
    const cacheKey = `js_${this.hashString(codeSnippet)}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      const prompt = `Analyze this JavaScript code snippet to identify pagination logic:

Code:
\`\`\`javascript
${codeSnippet.substring(0, 2000)} // Limited to 2000 chars
\`\`\`

Context: ${context.substring(0, 500)}

Extract pagination information and return JSON:
{
  "type": "query" | "body" | "header" | "response" | "ui",
  "location": "query.page" | "body.pagination.page" | etc,
  "paramName": "page" | "offset" | etc,
  "pattern": "page" | "offset" | "cursor"
}`;

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a JavaScript code analyzer. Extract pagination patterns from code snippets. Return only valid JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.1, // Low temperature for deterministic results
      });

      const content = response.choices[0]?.message?.content || "";
      const result = this.parseJSONResponse<PaginationPattern>(content);
      if (result) {
        this.cache.set(cacheKey, result);
      }
      return result;
    } catch (error) {
      console.warn("JavaScript analysis failed:", error);
      return null;
    }
  }

  /**
   * Determine first page handling when tests are inconclusive
   */
  async analyzeFirstPageBehavior(
    page1Url: string,
    page1Response: string,
    page2Url: string,
    page2Response: string
  ): Promise<FirstPageAnalysis> {
    if (!this.openai) {
      return {
        different: false,
        preferredApproach: "explicit-param",
        reasoning: "LLM not available",
      };
    }

    // Check cache
    const cacheKey = `firstpage_${this.hashString(page1Url)}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      const prompt = `Analyze these two page requests to determine if the first page is handled differently:

Page 1 URL: ${page1Url}
Page 1 Response (first 1000 chars): ${page1Response.substring(0, 1000)}

Page 2 URL: ${page2Url}
Page 2 Response (first 1000 chars): ${page2Response.substring(0, 1000)}

Return JSON:
{
  "different": boolean,
  "preferredApproach": "no-param" | "explicit-param",
  "reasoning": "brief explanation"
}`;

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a pagination expert. Analyze if first page needs special handling. Return only valid JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content || "";
      const result = this.parseJSONResponse<FirstPageAnalysis>(content);
      if (result) {
        this.cache.set(cacheKey, result);
        return result;
      }
    } catch (error) {
      console.warn("First page analysis failed:", error);
    }

    return {
      different: false,
      preferredApproach: "explicit-param",
      reasoning: "Analysis failed",
    };
  }

  /**
   * Rank candidates when rule-based scoring is tied
   */
  async rankCandidates(
    candidates: PaginationCandidate[],
    testResults: PaginationTestResult[],
    context: string
  ): Promise<RankedCandidate[]> {
    if (!this.openai || candidates.length <= 1) {
      return candidates.map((c, i) => ({
        candidate: c,
        rank: i + 1,
        reasoning: "No LLM ranking needed",
      }));
    }

    // Only use LLM if scores are very close (within 0.1)
    const scores = candidates.map((c) => c.confidence);
    const maxScore = Math.max(...scores);
    const closeScores = scores.filter((s) => Math.abs(s - maxScore) < 0.1);

    if (closeScores.length <= 1) {
      // Scores are clearly different, no need for LLM
      return candidates
        .sort((a, b) => b.confidence - a.confidence)
        .map((c, i) => ({
          candidate: c,
          rank: i + 1,
          reasoning: "Rule-based ranking",
        }));
    }

    // Check cache
    const cacheKey = `rank_${this.hashCandidates(candidates)}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      const prompt = this.buildRankingPrompt(candidates, testResults, context);
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a pagination expert. Rank pagination candidates by likelihood of correctness. Return only valid JSON array.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content || "";
      const result = this.parseRankingResponse(content, candidates);
      if (result) {
        this.cache.set(cacheKey, result);
      }
      return (
        result ||
        candidates.map((c, i) => ({
          candidate: c,
          rank: i + 1,
          reasoning: "Fallback ranking",
        }))
      );
    } catch (error) {
      console.warn("LLM ranking failed, using rule-based:", error);
      return candidates
        .sort((a, b) => b.confidence - a.confidence)
        .map((c, i) => ({
          candidate: c,
          rank: i + 1,
          reasoning: "Rule-based fallback",
        }));
    }
  }

  /**
   * Clear cache (useful for testing or memory management)
   */
  clearCache(): void {
    this.cache.clear();
  }

  // Private helper methods

  private buildAmbiguousPatternsPrompt(
    candidates: PaginationCandidate[],
    context: PaginationContext
  ): string {
    return `Multiple pagination candidates detected. Analyze and rank them:

Candidates:
${candidates
  .map(
    (c, i) =>
      `${i + 1}. Type: ${c.type}, Location: ${c.location}, Confidence: ${
        c.confidence
      }`
  )
  .join("\n")}

Context:
URL: ${context.url || "N/A"}
Method: ${context.method || "N/A"}
Response Type: ${context.responseType || "N/A"}

Return JSON array of candidate indices in order of likelihood (most likely first):
[0, 2, 1, ...]`;
  }

  private buildRankingPrompt(
    candidates: PaginationCandidate[],
    testResults: PaginationTestResult[],
    context: string
  ): string {
    return `Rank these pagination candidates by correctness:

Candidates:
${candidates
  .map(
    (c, i) => `${i}. ${c.type} - ${c.location} (confidence: ${c.confidence})`
  )
  .join("\n")}

Test Results:
${testResults
  .map((tr, i) => `${i}. Passed: ${tr.passed}, Confidence: ${tr.confidence}`)
  .join("\n")}

Context: ${context.substring(0, 500)}

Return JSON array with rankings:
[
  {"index": 0, "rank": 1, "reasoning": "..."},
  {"index": 1, "rank": 2, "reasoning": "..."}
]`;
  }

  private parseAmbiguousResponse(content: string): PaginationCandidate[] {
    try {
      const indices = JSON.parse(content);
      if (Array.isArray(indices)) {
        // This would need the original candidates array - simplified for now
        return [];
      }
    } catch {
      // Invalid response
    }
    return [];
  }

  private parseRankingResponse(
    content: string,
    candidates: PaginationCandidate[]
  ): RankedCandidate[] | null {
    try {
      const rankings = JSON.parse(content);
      if (Array.isArray(rankings)) {
        return rankings
          .map((r: any) => {
            const candidate = candidates[r.index];
            if (!candidate) return null;
            return {
              candidate,
              rank: r.rank,
              reasoning: r.reasoning || "",
            };
          })
          .filter((r): r is RankedCandidate => r !== null);
      }
    } catch {
      // Invalid response
    }
    return null;
  }

  private parseJSONResponse<T>(content: string): T | null {
    try {
      // Extract JSON from markdown code blocks if present
      const jsonMatch =
        content.match(/```json\s*([\s\S]*?)\s*```/) ||
        content.match(/```\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      if (!jsonStr) return null;
      return JSON.parse(jsonStr.trim()) as T;
    } catch {
      return null;
    }
  }

  private hashCandidates(candidates: PaginationCandidate[]): string {
    return candidates
      .map((c) => `${c.type}_${c.location}_${c.confidence}`)
      .join("|");
  }

  private hashContext(context: PaginationContext): string {
    return `${context.url || ""}_${context.method || ""}`;
  }

  private hashString(str: string): string {
    // Simple hash for caching
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }
}
