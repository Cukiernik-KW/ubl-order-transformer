import { describe, expect, it } from "vitest";
import { AppError } from "../../src/domain/errors.js";
import { unwrapPushEnvelope } from "../../src/http/pubsubEnvelope.js";
import { pushEnvelope } from "../helpers/index.js";

describe("unwrapPushEnvelope", () => {
  it("decodes data into the application message and keeps Pub/Sub metadata", () => {
    const appMessage = { messageId: "7a1e78c9", document: "PE9yZGVyLz4=" };
    expect(
      unwrapPushEnvelope(pushEnvelope(appMessage, { pubsubMessageId: "ps-9", deliveryAttempt: 3 })),
    ).toEqual({ appMessage, pubsubMessageId: "ps-9", deliveryAttempt: 3 });
  });

  it("leaves deliveryAttempt undefined when the subscription has no dead-letter policy", () => {
    expect(unwrapPushEnvelope(pushEnvelope({})).deliveryAttempt).toBeUndefined();
  });

  it("passes non-JSON data on as text (bad partner content, rejected by the processor)", () => {
    expect(unwrapPushEnvelope(pushEnvelope("<Order/>")).appMessage).toBe("<Order/>");
  });

  it.each([
    ["no body", undefined],
    ["an app message instead of an envelope", { messageId: "m1", document: "x" }],
    ["missing data", { message: { messageId: "ps-1" }, subscription: "s" }],
    ["missing subscription", { message: { data: "e30=", messageId: "ps-1" } }],
    ["a non-numeric deliveryAttempt", { ...pushEnvelope({}), deliveryAttempt: "2" }],
  ])("rejects %s with a 400 ValidationError", (_case, body) => {
    expect(() => unwrapPushEnvelope(body)).toThrow(AppError);
    expect(() => unwrapPushEnvelope(body)).toThrow("Invalid Pub/Sub push envelope.");
  });
});
