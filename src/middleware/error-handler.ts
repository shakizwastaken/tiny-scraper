import { type Request, type Response, type NextFunction } from "express";

/**
 * Centralized error handling middleware
 */
export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  console.error("\n=== ERROR OCCURRED ===");
  console.error(
    "Error type:",
    error instanceof Error ? error.constructor.name : typeof error
  );
  console.error(
    "Error message:",
    error instanceof Error ? error.message : String(error)
  );
  if (error instanceof Error && error.stack) {
    console.error("Stack trace:", error.stack);
  }

  if (error instanceof Error) {
    if (error.message.includes("timeout")) {
      console.error("❌ Request timeout error");
      res.status(408).json({
        error: "Request timeout",
        message: error.message,
      });
      return;
    }
    if (error.message.includes("net::ERR")) {
      console.error("❌ Network error");
      res.status(502).json({
        error: "Network error",
        message: error.message,
      });
      return;
    }
    console.error("❌ General scraping error");
    res.status(500).json({
      error: "Scraping failed",
      message: error.message,
    });
    return;
  }

  console.error("❌ Unknown error type");
  res.status(500).json({ error: "Unknown error occurred" });
}

