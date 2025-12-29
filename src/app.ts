import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { scrapeHandler } from "./routes/scrape.route";
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

// Error handling middleware (must be last)
app.use(errorHandler);

export default app;
