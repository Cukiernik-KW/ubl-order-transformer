import { z } from "zod";
import { validationError } from "../domain/errors.js";

/**
 * Body of a Pub/Sub push request (wrapped format):
 * { message: { data: Base64, messageId, publishTime, attributes }, subscription, deliveryAttempt? }
 * deliveryAttempt is present only when the subscription has a dead-letter policy.
 */
const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string().min(1),
    publishTime: z.string().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
  }),
  subscription: z.string().min(1),
  deliveryAttempt: z.number().int().positive().optional(),
});

export interface UnwrappedPush {
  /** The application message: parsed JSON, or the raw text when `data` is not valid JSON. */
  appMessage: unknown;
  pubsubMessageId: string;
  deliveryAttempt?: number;
}

/**
 * Pub/Sub Base64-encodes `data`; inside it is the partner's JSON, whose `document` is Base64 again.
 * An invalid envelope is a 400 (real Pub/Sub never sends one). `data` that is not JSON is passed on
 * as text: it is bad partner content, and the processor rejects and dead-letters it.
 */
export function unwrapPushEnvelope(body: unknown): UnwrappedPush {
  const parsed = PushEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw validationError(["Invalid Pub/Sub push envelope."]);
  }
  const { message, deliveryAttempt } = parsed.data;

  // Pub/Sub always sends valid Base64 here, so a lenient decode is fine.
  const text = Buffer.from(message.data, "base64").toString("utf8");
  let appMessage: unknown;
  try {
    appMessage = JSON.parse(text);
  } catch {
    appMessage = text;
  }
  return { appMessage, pubsubMessageId: message.messageId, deliveryAttempt };
}
