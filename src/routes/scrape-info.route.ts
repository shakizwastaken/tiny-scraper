import { type Request, type Response } from "express";
import { getScrapingMetadata } from "../services/storage.service";

/**
 * Get metadata about stored scraping instructions
 */
export async function scrapeInfoHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { id } = req.params;

  console.log("\n=== GET SCRAPING INFO ===");
  console.log("ID:", id);

  if (!id) {
    res.status(400).json({ error: "Missing ID parameter" });
    return;
  }

  try {
    const metadata = await getScrapingMetadata(id);

    if (!metadata) {
      res.status(404).json({ error: `Scraping instructions not found for ID: ${id}` });
      return;
    }

    res.json(metadata);
  } catch (error) {
    // Error handling is done by the error handler middleware
    throw error;
  }
}

