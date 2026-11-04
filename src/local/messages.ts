/**
 * Builders for the two message shapes, shared by the local scripts (samples, simulate, publish:local)
 * and the tests, so there is one definition of "what the partner sends" and "what Pub/Sub pushes".
 */

export interface AppMessage {
  messageId: string;
  timestamp: string;
  document: string;
}

/** What the partner publishes to orders.ubl.received: the XML, Base64-encoded, plus metadata. */
export function createAppMessage(
  xml: string,
  options: { messageId: string; timestamp?: string },
): AppMessage {
  return {
    messageId: options.messageId,
    timestamp: options.timestamp ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    document: Buffer.from(xml, "utf8").toString("base64"),
  };
}

export interface PushEnvelope {
  message: {
    data: string;
    messageId: string;
    publishTime: string;
    attributes: Record<string, string>;
  };
  subscription: string;
  deliveryAttempt?: number;
}

export function isPushEnvelope(value: unknown): value is PushEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    "subscription" in value
  );
}

/**
 * What a Pub/Sub push subscription POSTs: the published payload (JSON text, or raw text) is
 * Base64-encoded into `message.data`, so the XML ends up Base64-encoded twice.
 */
export function wrapInPushEnvelope(
  payload: unknown,
  options: {
    pubsubMessageId?: string;
    deliveryAttempt?: number;
    publishTime?: string;
    subscription?: string;
  } = {},
): PushEnvelope {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    message: {
      data: Buffer.from(text, "utf8").toString("base64"),
      messageId: options.pubsubMessageId ?? "1",
      publishTime: options.publishTime ?? new Date().toISOString(),
      attributes: {},
    },
    subscription:
      options.subscription ?? "projects/local/subscriptions/orders.ubl.received.transformer",
    ...(options.deliveryAttempt === undefined ? {} : { deliveryAttempt: options.deliveryAttempt }),
  };
}
