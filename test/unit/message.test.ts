import { describe, expect, it } from "vitest";
import { AppError } from "../../src/domain/errors.js";
import { extractMessageId, parseAppMessage } from "../../src/domain/message.js";

const valid = {
  messageId: "7a1e78c9",
  timestamp: "2026-07-27T12:00:00Z",
  document: "PE9yZGVyLz4=",
};

function validationIssues(input: unknown): { message: string; details: readonly string[] } {
  try {
    parseAppMessage(input);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const appError = err as AppError;
    expect(appError.code).toBe("ValidationError");
    expect(appError.httpStatus).toBe(400);
    expect(appError.permanent).toBe(true);
    return { message: appError.message, details: appError.details };
  }
  return expect.fail("expected ValidationError");
}

describe("parseAppMessage", () => {
  it("accepts a valid message", () => {
    expect(parseAppMessage(valid)).toEqual(valid);
  });

  it("treats timestamp as optional", () => {
    const { timestamp: _omitted, ...withoutTimestamp } = valid;
    expect(parseAppMessage(withoutTimestamp)).toEqual(withoutTimestamp);
  });

  it("trims messageId and drops unknown fields", () => {
    expect(parseAppMessage({ ...valid, messageId: "  abc  ", extra: 1 })).toEqual({
      ...valid,
      messageId: "abc",
    });
  });

  it.each([null, undefined])("rejects a missing message (%s)", (input) => {
    expect(validationIssues(input).message).toBe("Message is required.");
  });

  it.each([["a string"], [[valid]], [42]])("rejects a non-object message (%j)", (input) => {
    expect(validationIssues(input).message).toBe("Message must be a JSON object.");
  });

  it("rejects a missing messageId", () => {
    const { messageId: _omitted, ...input } = valid;
    expect(validationIssues(input).message).toBe("messageId is required.");
  });

  it.each(["", "   "])("rejects an empty messageId (%j)", (messageId) => {
    expect(validationIssues({ ...valid, messageId }).message).toBe("messageId is required.");
  });

  it("rejects a numeric messageId", () => {
    expect(validationIssues({ ...valid, messageId: 123 }).message).toBe(
      "messageId must be a string.",
    );
  });

  it("rejects a missing document", () => {
    const { document: _omitted, ...input } = valid;
    expect(validationIssues(input).message).toBe("document is required.");
  });

  it.each(["", "  \n "])("rejects an empty document (%j)", (document) => {
    expect(validationIssues({ ...valid, document }).message).toBe("document must not be empty.");
  });

  it("reports every issue in details", () => {
    expect(validationIssues({}).details).toEqual([
      "messageId is required.",
      "document is required.",
    ]);
  });
});

describe("extractMessageId", () => {
  it("returns the messageId even when the rest of the message is invalid", () => {
    expect(extractMessageId({ messageId: " 7a1e78c9 ", document: "" })).toBe("7a1e78c9");
  });

  it.each([null, "text", [], {}, { messageId: 1 }, { messageId: "  " }])(
    "returns null when there is no usable messageId (%j)",
    (input) => {
      expect(extractMessageId(input)).toBeNull();
    },
  );
});
