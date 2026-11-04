import { z } from "zod";
import { validationError } from "./errors.js";

/** The application message: `{ messageId, timestamp, document }` (spec "Sample Pub/Sub Message"). */
const AppMessageSchema = z.object({
  messageId: z
    .string({
      error: (issue) =>
        issue.input === undefined ? "messageId is required." : "messageId must be a string.",
    })
    .trim()
    .min(1, { error: "messageId is required." }),
  // Not required by spec Step 1; kept for logging only (ADR-002).
  timestamp: z.string({ error: "timestamp must be a string." }).optional(),
  document: z
    .string({
      error: (issue) =>
        issue.input === undefined ? "document is required." : "document must be a string.",
    })
    .refine((doc) => doc.trim().length > 0, { error: "document must not be empty." }),
});

export type AppMessage = z.infer<typeof AppMessageSchema>;

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** Spec Step 1. Throws ValidationError listing every issue. Unknown fields are dropped. */
export function parseAppMessage(input: unknown): AppMessage {
  if (input === null || input === undefined) {
    throw validationError(["Message is required."]);
  }
  if (!isPlainObject(input)) {
    throw validationError(["Message must be a JSON object."]);
  }
  const result = AppMessageSchema.safeParse(input);
  if (!result.success) {
    throw validationError(result.error.issues.map((issue) => issue.message));
  }
  return result.data;
}

/**
 * Best-effort messageId for error responses, even when the rest of the message is invalid
 * (the spec's error bodies always carry it).
 */
export function extractMessageId(input: unknown): string | null {
  if (!isPlainObject(input)) return null;
  const id = input.messageId;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}
