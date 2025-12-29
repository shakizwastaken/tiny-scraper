import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { scrapeHandler } from "./routes/scrape.route";
import { executeScrapeHandler } from "./routes/scrape-execute.route";
import { scrapeInfoHandler } from "./routes/scrape-info.route";
import { errorHandler } from "./middleware/error-handler";

const app = express();

// Middleware
app.use(express.json());

// Async error wrapper
const asyncHandler = (fn: (req: Request, res: Response) => Promise<void>) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
};

// Routes
app.get("/scrape", asyncHandler(scrapeHandler));
app.get("/scrape/:id/info", asyncHandler(scrapeInfoHandler));
app.get("/scrape/:id", asyncHandler(executeScrapeHandler));

// Error handling middleware (must be last)
app.use(errorHandler);

export default app;
