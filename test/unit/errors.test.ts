import { describe, expect, it } from "vitest";
import {
  AppError,
  invalidBase64,
  invalidXml,
  serverError,
  validationError,
} from "../../src/domain/errors.js";

describe("error factories (spec error contract)", () => {
  it.each([
    [
      validationError(["Order ID is required."]),
      "ValidationError",
      400,
      true,
      "Order ID is required.",
    ],
    [invalidBase64(), "InvalidBase64", 400, true, "Document is not a valid Base64 string."],
    [invalidXml(), "InvalidXml", 400, true, "Message could not be parsed from XML to JSON."],
    [serverError(), "ServerError", 500, false, "An unexpected error occurred."],
  ])("%s", (error, code, httpStatus, permanent, message) => {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code, httpStatus, permanent, message });
  });

  it("validationError uses the first issue as message and keeps all of them in details", () => {
    const error = validationError(["first", "second"]);
    expect(error.message).toBe("first");
    expect(error.details).toEqual(["first", "second"]);
  });

  it("serverError keeps the original cause for logging, not for the response", () => {
    const cause = new Error("connection reset");
    expect(serverError(cause).cause).toBe(cause);
  });
});
