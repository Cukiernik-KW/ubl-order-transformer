import { Router, type Request } from "express";
import type { Processor } from "../pipeline/processor.js";
import { unwrapPushEnvelope } from "./pubsubEnvelope.js";
import { toMessagesResponse, toPushResponse } from "./responses.js";

/**
 * Body-parser turns an empty request into `{}`; the spec's first check is "message exists", so an
 * empty request must be reported as a missing message. Same rule as type-is' hasBody().
 */
function bodyOf(req: Request): unknown {
  const hasBody =
    req.headers["transfer-encoding"] !== undefined ||
    (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0");
  return hasBody ? req.body : undefined;
}

export function createRoutes(processMessage: Processor): Router {
  const router = Router();

  // Liveness. Not /healthz: Cloud Run reserves some paths ending in "z" at its frontend.
  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // The spec's "endpoint for validation": the application message, synchronously.
  router.post("/messages", async (req, res) => {
    const result = await processMessage(bodyOf(req), { source: "http" });
    const { status, body } = toMessagesResponse(result);
    res.status(status).json(body);
  });

  // Pub/Sub push subscription target. Thrown envelope errors go to the error handler (400).
  router.post("/pubsub/push", async (req, res) => {
    const { appMessage, pubsubMessageId, deliveryAttempt } = unwrapPushEnvelope(bodyOf(req));
    const result = await processMessage(appMessage, {
      source: "push",
      pubsubMessageId,
      deliveryAttempt,
    });
    const { status, body } = toPushResponse(result);
    res.status(status).json(body);
  });

  return router;
}
