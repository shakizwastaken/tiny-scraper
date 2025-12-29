import OpenAI from "openai";

// Load OpenAI API key from environment
const openaiApiKey = process.env.OPENAI_API_KEY;
if (!openaiApiKey) {
  console.warn("⚠️  OPENAI_API_KEY not found in environment variables");
}

export const openai = openaiApiKey
  ? new OpenAI({ apiKey: openaiApiKey })
  : null;

export const OPENAI_MODEL = "gpt-4.1-mini-2025-04-14";
export const OPENAI_MAX_TOKENS = 4000;
export const OPENAI_TEMPERATURE = 0.3;

export const BROWSER_ARGS = ["--no-sandbox", "--disable-setuid-sandbox"];
export const NAVIGATION_TIMEOUT = 30000;
export const RESPONSE_WAIT_TIME = 2000;

