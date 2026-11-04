import { describe, expect, it } from "vitest";
import { AppError } from "../../src/domain/errors.js";
import { mapUblOrder } from "../../src/domain/ublMapper.js";
import { parseXml } from "../../src/domain/xml.js";
import { buildOrderXml, readFixture, type OrderSpec } from "../fixtures/index.js";

const ctx = {
  messageId: "7a1e78c9",
  // Milliseconds on purpose: the output must use seconds precision, like the spec example.
  transformedAt: new Date("2026-07-27T12:01:00.123Z"),
};

const map = (xml: string) => mapUblOrder(parseXml(xml), ctx);
const mapSpec = (spec: OrderSpec) => map(buildOrderXml(spec));

function validationError(run: () => unknown): { message: string; details: readonly string[] } {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const appError = err as AppError;
    expect(appError.code).toBe("ValidationError");
    expect(appError.httpStatus).toBe(400);
    return { message: appError.message, details: appError.details };
  }
  return expect.fail("expected ValidationError");
}

describe("mapUblOrder: golden test", () => {
  it("maps the spec sample to exactly the spec output", () => {
    const output = map(readFixture("order.sample.xml"));
    expect(output).toEqual({
      messageId: "7a1e78c9",
      transformedAt: "2026-07-27T12:01:00Z",
      order: {
        orderId: "12347",
        externalOrganizationId: "1234567",
        reference: "test-order",
        orderDate: "2025-01-01",
        lines: [
          {
            lineId: 1,
            itemId: "100100",
            quantity: 1,
            unitOfMeasure: "EA",
            comment: "Optional OrderLine Note",
          },
          {
            lineId: 2,
            itemId: "100103",
            quantity: 1,
            unitOfMeasure: "EA",
            comment: "Optional OrderLine Note",
          },
        ],
      },
    });
  });

  it("produces keys in the spec order", () => {
    const output = map(readFixture("order.sample.xml"));
    expect(Object.keys(output)).toEqual(["messageId", "transformedAt", "order"]);
    expect(Object.keys(output.order)).toEqual([
      "orderId",
      "externalOrganizationId",
      "reference",
      "orderDate",
      "lines",
    ]);
    expect(Object.keys(output.order.lines[0] ?? {})).toEqual([
      "lineId",
      "itemId",
      "quantity",
      "unitOfMeasure",
      "comment",
    ]);
  });

  it("maps the same order written with different namespace prefixes", () => {
    const output = map(readFixture("order.other-prefixes.xml"));
    expect(output.order).toMatchObject({ orderId: "12347", externalOrganizationId: "1234567" });
    expect(output.order.lines).toHaveLength(1);
  });

  it("maps an order with exactly one OrderLine", () => {
    const output = map(readFixture("order.single-line.xml"));
    expect(output.order.lines).toEqual([
      { lineId: 1, itemId: "000123", quantity: 2.5, unitOfMeasure: "KGM", comment: null },
    ]);
    expect(output.order.reference).toBeNull();
  });
});

describe("mapUblOrder: field rules", () => {
  it("trims whitespace around values", () => {
    const output = mapSpec({
      id: "\t 12347 \n",
      accountId: " 1234567 ",
      lines: [{ itemId: " 100100 ", unitCode: " EA " }],
    });
    expect(output.order.orderId).toBe("12347");
    expect(output.order.externalOrganizationId).toBe("1234567");
    expect(output.order.lines[0]).toMatchObject({ itemId: "100100", unitOfMeasure: "EA" });
  });

  it("keeps leading zeros in itemId", () => {
    expect(mapSpec({ lines: [{ itemId: "000123" }] }).order.lines[0]?.itemId).toBe("000123");
  });

  it("maps a missing CustomerReference to null", () => {
    expect(mapSpec({ customerReference: null }).order.reference).toBeNull();
  });

  it("maps a missing Note to null", () => {
    expect(mapSpec({ lines: [{ notes: [] }] }).order.lines[0]?.comment).toBeNull();
  });

  it("joins several Notes with a newline", () => {
    expect(mapSpec({ lines: [{ notes: ["first", "second"] }] }).order.lines[0]?.comment).toBe(
      "first\nsecond",
    );
  });

  it.each([
    ["2.5", 2.5],
    ["0.001", 0.001],
    ["10", 10],
    ["3.", 3],
    [".5", 0.5],
  ])("accepts decimal quantity %j", (quantity, expected) => {
    expect(mapSpec({ lines: [{ quantity }] }).order.lines[0]?.quantity).toBe(expected);
  });

  it("accepts lineId with leading zeros", () => {
    expect(mapSpec({ lines: [{ id: "007" }] }).order.lines[0]?.lineId).toBe(7);
  });

  it("accepts IssueDate with a timezone and outputs the date part", () => {
    expect(mapSpec({ issueDate: "2025-01-01+01:00" }).order.orderDate).toBe("2025-01-01");
    expect(mapSpec({ issueDate: "2025-01-01Z" }).order.orderDate).toBe("2025-01-01");
  });
});

describe("mapUblOrder: validation errors", () => {
  it("requires the root element to be Order", () => {
    const xml = readFixture("order.sample.xml")
      .replace(/<Order\b/, "<Invoice")
      .replace("</Order>", "</Invoice>");
    expect(validationError(() => map(xml)).message).toBe("Root element must be Order.");
  });

  it("returns the spec message for a missing Order ID", () => {
    expect(validationError(() => mapSpec({ id: null })).message).toBe("Order ID is required.");
  });

  it("treats a whitespace-only Order ID as missing", () => {
    expect(validationError(() => mapSpec({ id: "  \t " })).message).toBe("Order ID is required.");
  });

  it("requires IssueDate", () => {
    expect(validationError(() => mapSpec({ issueDate: null })).message).toBe(
      "Order issue date is required.",
    );
  });

  it.each(["2025-02-30", "2025-13-01", "01-01-2025", "2025-1-1", "2025-01-01T10:00:00"])(
    "rejects invalid IssueDate %j",
    (issueDate) => {
      expect(validationError(() => mapSpec({ issueDate })).message).toBe(
        "Order issue date must be a valid date (YYYY-MM-DD).",
      );
    },
  );

  it("requires the buyer account ID", () => {
    expect(validationError(() => mapSpec({ accountId: null })).message).toBe(
      "Buyer account ID (BuyerCustomerParty/SupplierAssignedAccountID) is required.",
    );
  });

  it("requires at least one OrderLine", () => {
    expect(validationError(() => mapSpec({ lines: [] })).message).toBe(
      "At least one order line is required.",
    );
  });

  it.each(["0", "-1", "abc", "1e3", "0x10", "1,5", "Infinity"])(
    "rejects quantity %j",
    (quantity) => {
      expect(validationError(() => mapSpec({ lines: [{ quantity }] })).message).toBe(
        "Order line 1: quantity must be a positive number.",
      );
    },
  );

  it("requires quantity", () => {
    expect(validationError(() => mapSpec({ lines: [{ quantity: null }] })).details).toContain(
      "Order line 1: quantity is required.",
    );
  });

  it("requires unitCode and never defaults it", () => {
    expect(validationError(() => mapSpec({ lines: [{ unitCode: null }] })).message).toBe(
      "Order line 1: unit of measure (Quantity/@unitCode) is required.",
    );
  });

  it.each(["1.5", "abc", "0", "-2", "99999999999999999999"])("rejects lineId %j", (id) => {
    expect(validationError(() => mapSpec({ lines: [{ id }] })).message).toBe(
      "Order line 1: line ID must be a positive integer.",
    );
  });

  it("requires lineId and itemId", () => {
    const { details } = validationError(() => mapSpec({ lines: [{ id: null, itemId: null }] }));
    expect(details).toEqual([
      "Order line 1: line ID is required.",
      "Order line 1: item ID (SellersItemIdentification/ID) is required.",
    ]);
  });

  it("rejects duplicate lineIds (including 1 vs 01)", () => {
    expect(validationError(() => mapSpec({ lines: [{ id: "1" }, { id: "01" }] })).message).toBe(
      "Duplicate line ID: 1.",
    );
  });

  it("rejects an element that UBL allows only once", () => {
    const xml = buildOrderXml().replace(
      "<cbc:ID>12347</cbc:ID>",
      "<cbc:ID>1</cbc:ID><cbc:ID>2</cbc:ID>",
    );
    expect(validationError(() => map(xml)).details).toContain("Order ID must appear only once.");
  });

  it("collects every issue; message is the first one", () => {
    const { message, details } = validationError(() =>
      mapSpec({ id: null, accountId: null, lines: [{}, { quantity: "-1" }] }),
    );
    expect(message).toBe("Order ID is required.");
    expect(details).toEqual([
      "Order ID is required.",
      "Buyer account ID (BuyerCustomerParty/SupplierAssignedAccountID) is required.",
      "Order line 2: quantity must be a positive number.",
    ]);
  });

  it("names the failing line by its position", () => {
    expect(
      validationError(() => mapSpec({ lines: [{ id: "1" }, { id: "2", itemId: null }] })).message,
    ).toBe("Order line 2: item ID (SellersItemIdentification/ID) is required.");
  });

  it("maps an empty <Order/> to field-level errors", () => {
    expect(validationError(() => map("<Order/>")).details).toEqual([
      "Order ID is required.",
      "Order issue date is required.",
      "Buyer account ID (BuyerCustomerParty/SupplierAssignedAccountID) is required.",
      "At least one order line is required.",
    ]);
  });
});

describe("mapUblOrder: structural edge cases", () => {
  it("requires a LineItem in every OrderLine", () => {
    const xml = buildOrderXml().replace(/<cac:LineItem>[\s\S]*<\/cac:LineItem>/, "");
    expect(validationError(() => map(xml)).details).toEqual([
      "Order line 1: LineItem is required.",
    ]);
  });

  it("reports a repeated LineItem once, not also as missing", () => {
    const xml = buildOrderXml().replace(/(<cac:LineItem>[\s\S]*<\/cac:LineItem>)/, "$1$1");
    expect(validationError(() => map(xml)).details).toEqual([
      "Order line 1: LineItem must appear only once.",
    ]);
  });
});
