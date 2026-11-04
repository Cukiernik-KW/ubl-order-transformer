import { describe, expect, it } from "vitest";
import { decodeBase64Strict } from "../../src/domain/base64.js";
import { AppError } from "../../src/domain/errors.js";

const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");

function expectInvalidBase64(input: string) {
  try {
    decodeBase64Strict(input);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      code: "InvalidBase64",
      httpStatus: 400,
      permanent: true,
      message: "Document is not a valid Base64 string.",
    });
    return;
  }
  expect.fail(`expected InvalidBase64 for ${JSON.stringify(input)}`);
}

describe("decodeBase64Strict", () => {
  it("decodes valid Base64", () => {
    expect(decodeBase64Strict(encode("<Order/>")).toString("utf8")).toBe("<Order/>");
  });

  it("decodes all padding variants", () => {
    expect(decodeBase64Strict("QQ==").toString()).toBe("A");
    expect(decodeBase64Strict("QUI=").toString()).toBe("AB");
    expect(decodeBase64Strict("QUJD").toString()).toBe("ABC");
  });

  it("accepts MIME-style line breaks and surrounding whitespace", () => {
    const wrapped = encode("<Order>with a longer body</Order>").replace(/(.{8})/g, "$1\r\n");
    expect(decodeBase64Strict(`  ${wrapped}\n`).toString()).toBe(
      "<Order>with a longer body</Order>",
    );
  });

  it("documents why we need this: Buffer.from() never throws on garbage", () => {
    expect(() => Buffer.from("$$$ not base64 !!!", "base64")).not.toThrow();
    expect(Buffer.from("$$$ not base64 !!!", "base64").length).toBeGreaterThan(0);
  });

  it.each([
    ["characters outside the alphabet", "PE9y$GVyLz4="],
    ["plain text", "this is not base64!"],
    ["length not a multiple of 4", "QUJ"],
    ["padding in the middle", "QQ==QQ=="],
    ["too much padding", "Q==="],
    ["non-canonical trailing bits (QR== decodes to 'A' but 'A' encodes to QQ==)", "QR=="],
    ["base64url alphabet", "-_-_"],
    ["empty string", ""],
    ["whitespace only", " \n\t "],
  ])("rejects %s", (_case, input) => {
    expectInvalidBase64(input);
  });
});
