import OpenAI from "openai";
import type {
  InterceptedRequest,
  RequestSelectionResult,
} from "../types/scraping";
import { openai, OPENAI_REFINEMENT_MODEL } from "../config";

/**
 * Select the best request from multiple matches using LLM analysis
 */
export async function selectBestRequest(
  matches: InterceptedRequest[],
  searchTerm: string,
  expectedOutputType?: "array" | "object",
  customPrompt?: string
): Promise<RequestSelectionResult> {
  if (!openai) {
    throw new Error("OpenAI client not initialized");
  }

  if (matches.length === 0) {
    throw new Error("No matches provided");
  }

  if (matches.length === 1) {
    return {
      selectedIndex: 0,
      reasoning: "Only one match found, using it by default",
    };
  }

  console.log(
    `\n=== SELECTING BEST REQUEST FROM ${matches.length} MATCHES ===`
  );

  // Prepare request summaries for LLM
  const requestSummaries = matches.map((match, index) => {
    const request = match.request;
    const response = match.response;
    const responseBody = match.responseBody || "";
    const contentType = response?.headers()["content-type"] || "unknown";
    const statusCode = response?.status() || 0;
    const method = request.method();
    const url = request.url();
    const bodyLength = responseBody.length;
    const containsSearch = responseBody
      .toLowerCase()
      .includes(searchTerm.toLowerCase());

    // Extract preview of response body
    const preview = responseBody.substring(0, 500);
    const isJSON = contentType.includes("json");
    const isHTML = contentType.includes("html") || contentType.includes("xml");

    return {
      index,
      method,
      url,
      statusCode,
      contentType,
      bodyLength,
      containsSearch,
      isJSON,
      isHTML,
      preview: isJSON
        ? (() => {
            try {
              const parsed = JSON.parse(responseBody);
              return JSON.stringify(parsed).substring(0, 500);
            } catch {
              return preview;
            }
          })()
        : preview,
    };
  });

  // Build output type hint section
  const outputTypeHint = expectedOutputType
    ? `\nIMPORTANT OUTPUT TYPE HINT:
- The user expects the output to be: "${expectedOutputType}"
- When evaluating requests, prioritize those that would produce "${expectedOutputType}" output (array vs single object)
- If "${expectedOutputType}" is "array", prefer requests with array structures in their responses
`
    : "";

  // Build custom prompt section
  const customPromptSection = customPrompt
    ? `\nCUSTOM USER INSTRUCTIONS:
${customPrompt}

Please consider these instructions when selecting the best request.
`
    : "";

  const prompt = `You are an expert at analyzing API requests and responses. I have ${
    matches.length
  } HTTP requests that all contain the search term "${searchTerm}". I need you to select the BEST request for scraping data.${outputTypeHint}${customPromptSection}

Here are the ${matches.length} requests:

${requestSummaries
  .map(
    (req, i) => `
Request #${i + 1}:
- Method: ${req.method}
- URL: ${req.url}
- Status: ${req.statusCode}
- Content-Type: ${req.contentType}
- Response Body Length: ${req.bodyLength} characters
- Contains Search Term: ${req.containsSearch ? "Yes" : "No"}
- Preview:
${req.preview}
`
  )
  .join("\n---\n")}

Please analyze each request and select the BEST one for scraping. Consider:
1. Data Quality: Which response contains the most complete, structured data?
2. Completeness: Which response has the most relevant data?
3. Relevance: Which response best matches the search term in context?
4. Content Type: JSON is preferred over HTML for structured data, but HTML can work if it's the only option
5. Response Size: Appropriate size for the data (not too small = incomplete, not too large = hard to process)

Respond with ONLY a JSON object in this exact format:
{
  "selectedIndex": <0-based index of selected request>,
  "reasoning": "<brief explanation of why this request was selected>",
  "scores": {
    "<index>": {
      "dataQuality": <0-10>,
      "completeness": <0-10>,
      "relevance": <0-10>,
      "contentType": <0-10>,
      "total": <sum of all scores>
    }
  }
}

Return ONLY valid JSON, no markdown, no code blocks, no explanations outside the JSON.`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_REFINEMENT_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are an expert at analyzing API requests and selecting the best one for data scraping. Always return valid JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      max_tokens: 2000,
      temperature: 0.3,
    });

    const responseText = completion.choices[0]?.message?.content?.trim() || "";
    console.log(
      `✅ LLM selection response received (${responseText.length} chars)`
    );

    // Try to extract JSON from response (handle markdown code blocks if present)
    let jsonText = responseText;
    const jsonMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    if (jsonMatch) jsonText = jsonMatch[1] || "";

    const result = JSON.parse(jsonText) as RequestSelectionResult;

    // Validate selected index
    if (result.selectedIndex < 0 || result.selectedIndex >= matches.length) {
      console.warn(
        `⚠️  Invalid selected index ${result.selectedIndex}, defaulting to 0`
      );
      result.selectedIndex = 0;
    }

    console.log(
      `✅ Selected request #${result.selectedIndex + 1}: ${result.reasoning}`
    );

    return result;
  } catch (error) {
    console.error(
      `❌ Request selection failed:`,
      error instanceof Error ? error.message : error
    );
    // Fallback to first match
    console.log("⚠️  Falling back to first match");
    return {
      selectedIndex: 0,
      reasoning: "Selection failed, using first match as fallback",
    };
  }
}
