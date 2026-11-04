import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError, serverError, validationError } from "../domain/errors.js";
import type { Logger } from "../observability/logger.js";
import { errorBody } from "./responses.js";

interface BodyParserError {
  type?: unknown;
  status?: unknown;
}

function bodyParserErrorType(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as BodyParserError).type : undefined;
}

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "NotFound", message: "Route not found.", messageId: null });
};

/**
 * Errors that never reached the processor: unreadable body, oversized body, invalid push envelope,
 * bugs. The response never contains a stack trace or an internal message; details go to the log.
 */
export function errorHandler(logger: Logger, maxBodyBytes: number): ErrorRequestHandler {
  return (error: unknown, _req, res, _next) => {
    const type = bodyParserErrorType(error);

    if (type === "entity.parse.failed") {
      res.status(400).json(errorBody(validationError(["Request body must be valid JSON."]), null));
      return;
    }
    if (type === "entity.too.large") {
      const tooLarge = validationError([
        `Request body exceeds the limit of ${maxBodyBytes} bytes.`,
      ]);
      res.status(413).json(errorBody(tooLarge, null));
      return;
    }
    if (error instanceof AppError && error.permanent) {
      res.status(error.httpStatus).json(errorBody(error, null));
      return;
    }

    logger.error({ err: error }, "Unhandled error in HTTP layer");
    res.status(500).json(errorBody(serverError(), null));
  };
}
