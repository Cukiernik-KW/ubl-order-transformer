import express, { type Express } from "express";
import { errorHandler, notFound } from "./http/errorHandler.js";
import { createRoutes } from "./http/routes.js";
import type { Logger } from "./observability/logger.js";
import type { Processor } from "./pipeline/processor.js";

export interface AppDeps {
  processMessage: Processor;
  logger: Logger;
  maxBodyBytes: number;
}

/** Builds the HTTP app without listening, so tests drive it in memory (supertest) and server.ts owns the port. */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  app.use(
    express.json({
      limit: deps.maxBodyBytes,
      // Parse JSON regardless of Content-Type: `curl -d` defaults to form-urlencoded, which would
      // otherwise leave the body empty and produce a misleading "Message is required.".
      type: () => true,
    }),
  );
  app.use(createRoutes(deps.processMessage));
  app.use(notFound);
  app.use(errorHandler(deps.logger, deps.maxBodyBytes));
  return app;
}
