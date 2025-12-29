import { type Request, type Response } from "express";
import { scrapeWithInstructions, type PaginationOptions } from "../services/scraper.service";

/**
 * Execute scraping using stored instructions
 */
export async function executeScrapeHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { id } = req.params;
  const { page, limit, offset } = req.query;

  console.log("\n=== EXECUTE SCRAPING REQUEST ===");
  console.log("ID:", id);
  console.log("Query params:", { page, limit, offset });

  if (!id) {
    res.status(400).json({ error: "Missing ID parameter" });
    return;
  }

  try {
    // Build pagination options
    const paginationOptions: PaginationOptions = {};
    if (page !== undefined) {
      const pageNum = parseInt(String(page), 10);
      if (isNaN(pageNum) || pageNum < 1) {
        res.status(400).json({ error: "Invalid page parameter. Must be a positive integer." });
        return;
      }
      paginationOptions.page = pageNum;
    }
    if (limit !== undefined) {
      const limitNum = parseInt(String(limit), 10);
      if (isNaN(limitNum) || limitNum < 1) {
        res.status(400).json({ error: "Invalid limit parameter. Must be a positive integer." });
        return;
      }
      paginationOptions.limit = limitNum;
    }
    if (offset !== undefined) {
      const offsetNum = parseInt(String(offset), 10);
      if (isNaN(offsetNum) || offsetNum < 0) {
        res.status(400).json({ error: "Invalid offset parameter. Must be a non-negative integer." });
        return;
      }
      paginationOptions.offset = offsetNum;
    }

    // Execute scraping
    const result = await scrapeWithInstructions(id, paginationOptions);

    res.json(result);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    
    if (errorMessage.includes("not found")) {
      res.status(404).json({ error: errorMessage });
    } else {
      // Error handling is done by the error handler middleware
      throw error;
    }
  }
}

