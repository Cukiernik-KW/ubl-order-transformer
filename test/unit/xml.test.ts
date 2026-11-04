import { describe, expect, it } from "vitest";
import { AppError } from "../../src/domain/errors.js";
import { decodeUtf8, parseXml } from "../../src/domain/xml.js";
import { buildOrderXml, readFixture } from "../fixtures/index.js";

function expectInvalidXml(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      code: "InvalidXml",
      httpStatus: 400,
      permanent: true,
      message: "Message could not be parsed from XML to JSON.",
    });
    return (err as AppError).details;
  }
  return expect.fail("expected InvalidXml");
}

describe("decodeUtf8", () => {
  it("decodes UTF-8 and strips a BOM", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<a>é</a>")]);
    expect(decodeUtf8(bytes)).toBe("<a>é</a>");
  });

  it("rejects invalid UTF-8 instead of producing replacement characters", () => {
    expect(expectInvalidXml(() => decodeUtf8(Buffer.from([0x3c, 0x61, 0xff, 0xfe])))).toEqual([
      "Document is not valid UTF-8.",
    ]);
  });
});

describe("parseXml", () => {
  it("parses the spec sample, stripping namespace prefixes", () => {
    const doc = parseXml(readFixture("order.sample.xml"));
    expect(doc).toMatchObject({
      Order: {
        ID: "12347",
        IssueDate: "2025-01-01",
        CustomerReference: "test-order",
        BuyerCustomerParty: { SupplierAssignedAccountID: "1234567" },
      },
    });
  });

  it("does not expose xmlns declarations as attributes", () => {
    const doc = parseXml(readFixture("order.sample.xml"));
    expect(Object.keys(doc.Order as object).some((key) => key.includes("xmlns"))).toBe(false);
  });

  it("parses a single OrderLine and a single Note as arrays", () => {
    const doc = parseXml(buildOrderXml({ lines: [{ notes: ["only note"] }] }));
    const order = doc.Order as { OrderLine: Array<{ Note: unknown }> };
    expect(Array.isArray(order.OrderLine)).toBe(true);
    expect(order.OrderLine).toHaveLength(1);
    expect(order.OrderLine[0]?.Note).toEqual(["only note"]);
  });

  it("keeps values as strings (leading zeros are preserved)", () => {
    const doc = parseXml(buildOrderXml({ id: "00123" }));
    expect((doc.Order as { ID: unknown }).ID).toBe("00123");
  });

  it("exposes attributes and text of an element with attributes", () => {
    const doc = parseXml(buildOrderXml({ lines: [{ quantity: "2.50", unitCode: "KGM" }] }));
    const order = doc.Order as { OrderLine: Array<{ LineItem: { Quantity: unknown } }> };
    expect(order.OrderLine[0]?.LineItem.Quantity).toEqual({ "#text": "2.50", "@_unitCode": "KGM" });
  });

  it("decodes standard and numeric character entities", () => {
    const doc = parseXml("<Order><Ref>Smith &amp; Co &#233; &#x41;</Ref></Order>");
    expect(doc).toEqual({ Order: { Ref: "Smith & Co é A" } });
  });

  it("rejects a DOCTYPE (billion laughs / XXE)", () => {
    expect(expectInvalidXml(() => parseXml(readFixture("doctype-billion-laughs.xml")))).toEqual([
      "DOCTYPE declarations are not allowed.",
    ]);
  });

  it("rejects a DOCTYPE with an external entity (XXE)", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE o [<!ENTITY x SYSTEM "file:///etc/passwd">]><Order>&x;</Order>`;
    expectInvalidXml(() => parseXml(xxe));
  });

  it.each([
    ["an unclosed tag", "<Order><ID>1</Order>"],
    ["plain text", "hello world"],
    ["an empty document", ""],
    ["truncated XML", "<Order><ID>1</ID"],
    ["several root elements", "<Order/><Order/>"],
  ])("rejects %s", (_case, xml) => {
    const details = expectInvalidXml(() => parseXml(xml));
    expect(details.length).toBeGreaterThan(0);
  });

  it("reports the parser's line and column for malformed XML", () => {
    const [detail] = expectInvalidXml(() => parseXml("<Order>\n<ID>1</Order>"));
    expect(detail).toMatch(/line 2, column \d+/);
  });
});
