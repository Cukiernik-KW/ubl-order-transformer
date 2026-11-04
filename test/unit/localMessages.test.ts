import { describe, expect, it } from "vitest";
import { unwrapPushEnvelope } from "../../src/http/pubsubEnvelope.js";
import { createAppMessage, isPushEnvelope, wrapInPushEnvelope } from "../../src/local/messages.js";

describe("local message builders", () => {
  it("createAppMessage Base64-encodes the XML and defaults the timestamp to now (seconds precision)", () => {
    const message = createAppMessage("<Order/>", { messageId: "m1" });
    expect(message.messageId).toBe("m1");
    expect(Buffer.from(message.document, "base64").toString()).toBe("<Order/>");
    expect(message.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("wrapInPushEnvelope round-trips through the real envelope parser", () => {
    const appMessage = createAppMessage("<Order/>", { messageId: "m1", timestamp: "t" });
    const envelope = wrapInPushEnvelope(appMessage, { deliveryAttempt: 2 });
    expect(unwrapPushEnvelope(envelope)).toEqual({
      appMessage,
      pubsubMessageId: "1",
      deliveryAttempt: 2,
    });
  });

  it("wrapInPushEnvelope carries raw text unchanged", () => {
    expect(unwrapPushEnvelope(wrapInPushEnvelope("<Order/>")).appMessage).toBe("<Order/>");
  });

  it("isPushEnvelope tells envelopes from app messages", () => {
    expect(isPushEnvelope(wrapInPushEnvelope({}))).toBe(true);
    expect(isPushEnvelope(createAppMessage("<Order/>", { messageId: "m1" }))).toBe(false);
    expect(isPushEnvelope(null)).toBe(false);
    expect(isPushEnvelope("text")).toBe(false);
  });
});
