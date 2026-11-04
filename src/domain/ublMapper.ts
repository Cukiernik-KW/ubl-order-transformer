import { serverError, validationError } from "./errors.js";
import { formatTimestamp } from "./time.js";
import { TransformedOrderSchema, type OrderLine, type TransformedOrder } from "./types.js";
import { ATTRIBUTE_PREFIX, TEXT_NODE, type XmlNode } from "./xml.js";

export interface MapContext {
  messageId: string;
  transformedAt: Date;
}

// xsd:date: YYYY-MM-DD with an optional timezone (Z or +hh:mm / -hh:mm).
const XSD_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:Z|[+-]\d{2}:\d{2})?$/;
// Regex before Number(): Number() alone accepts "" (0), "1e3" (1000) and "0x10" (16).
const POSITIVE_INTEGER = /^\d+$/;
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

function isNode(value: unknown): value is XmlNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Text content of an element. The parser returns "text" for a plain element and
 * { "#text": "text", "@_attr": ... } for an element with attributes.
 * Empty/whitespace-only text counts as missing.
 */
function textOf(value: unknown): string | undefined {
  const raw = isNode(value) ? value[TEXT_NODE] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function attributeOf(value: unknown, name: string): string | undefined {
  return isNode(value) ? textOf(value[ATTRIBUTE_PREFIX + name]) : undefined;
}

/** Child of an element that UBL allows at most once. A repeated element is reported, not guessed. */
function single(parent: unknown, key: string, label: string, issues: string[]): unknown {
  if (!isNode(parent)) return undefined;
  const value = parent[key];
  if (Array.isArray(value)) {
    issues.push(`${label} must appear only once.`);
    return undefined;
  }
  return value;
}

function parseXsdDate(value: string): string | undefined {
  const match = XSD_DATE.exec(value);
  if (!match) return undefined;
  const [, y = "", m = "", d = ""] = match;
  // Reject impossible dates such as 2025-02-30 (Date.UTC would roll them over to March).
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const isReal =
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d);
  return isReal ? `${y}-${m}-${d}` : undefined;
}

function mapLine(line: unknown, position: number, issues: string[]): OrderLine | undefined {
  const label = `Order line ${position}`;

  const notes = isNode(line) && Array.isArray(line.Note) ? line.Note : [];
  const noteTexts = notes.map(textOf).filter((note): note is string => note !== undefined);
  // UBL allows 0..n Notes; several are joined with a newline (assumption).
  const comment = noteTexts.length > 0 ? noteTexts.join("\n") : null;

  const lineItem = single(line, "LineItem", `${label}: LineItem`, issues);
  if (!isNode(lineItem)) {
    // A repeated LineItem was already reported by single(); don't also call it missing.
    const repeated = isNode(line) && Array.isArray(line.LineItem);
    if (!repeated) issues.push(`${label}: LineItem is required.`);
    return undefined;
  }

  const lineIdText = textOf(single(lineItem, "ID", `${label}: line ID`, issues));
  let lineId: number | undefined;
  if (lineIdText === undefined) {
    issues.push(`${label}: line ID is required.`);
  } else if (
    !POSITIVE_INTEGER.test(lineIdText) ||
    !Number.isSafeInteger(Number(lineIdText)) ||
    Number(lineIdText) === 0
  ) {
    issues.push(`${label}: line ID must be a positive integer.`);
  } else {
    lineId = Number(lineIdText);
  }

  const item = single(lineItem, "Item", `${label}: Item`, issues);
  const identification = single(
    item,
    "SellersItemIdentification",
    `${label}: SellersItemIdentification`,
    issues,
  );
  // Kept as a string: item numbers can have leading zeros ("000123").
  const itemId = textOf(single(identification, "ID", `${label}: item ID`, issues));
  if (itemId === undefined) {
    issues.push(`${label}: item ID (SellersItemIdentification/ID) is required.`);
  }

  const quantityNode = single(lineItem, "Quantity", `${label}: quantity`, issues);
  const quantityText = textOf(quantityNode);
  let quantity: number | undefined;
  if (quantityText === undefined) {
    issues.push(`${label}: quantity is required.`);
  } else if (!DECIMAL.test(quantityText) || Number(quantityText) <= 0) {
    issues.push(`${label}: quantity must be a positive number.`);
  } else {
    quantity = Number(quantityText);
  }

  const unitOfMeasure = attributeOf(quantityNode, "unitCode");
  if (unitOfMeasure === undefined) {
    issues.push(`${label}: unit of measure (Quantity/@unitCode) is required.`);
  }

  if (
    lineId === undefined ||
    itemId === undefined ||
    quantity === undefined ||
    unitOfMeasure === undefined
  ) {
    return undefined;
  }
  return { lineId, itemId, quantity, unitOfMeasure, comment };
}

/**
 * Spec Step 4: parsed UBL 2.1 Order -> output JSON.
 * Collects every validation issue (ValidationError.details); `message` is the first one.
 */
export function mapUblOrder(doc: XmlNode, ctx: MapContext): TransformedOrder {
  if (!("Order" in doc)) {
    throw validationError(["Root element must be Order."]);
  }
  // <Order/> with no children parses as "", treat it as an Order with no fields.
  const order: XmlNode = isNode(doc.Order) ? doc.Order : {};
  const issues: string[] = [];

  const orderId = textOf(single(order, "ID", "Order ID", issues));
  if (orderId === undefined) issues.push("Order ID is required.");

  const issueDateText = textOf(single(order, "IssueDate", "Order issue date", issues));
  let orderDate: string | undefined;
  if (issueDateText === undefined) {
    issues.push("Order issue date is required.");
  } else {
    orderDate = parseXsdDate(issueDateText);
    if (orderDate === undefined) {
      issues.push("Order issue date must be a valid date (YYYY-MM-DD).");
    }
  }

  const buyer = single(order, "BuyerCustomerParty", "BuyerCustomerParty", issues);
  const externalOrganizationId = textOf(
    single(buyer, "SupplierAssignedAccountID", "Buyer account ID", issues),
  );
  if (externalOrganizationId === undefined) {
    issues.push("Buyer account ID (BuyerCustomerParty/SupplierAssignedAccountID) is required.");
  }

  // Optional in UBL; missing -> null (assumption).
  const reference =
    textOf(single(order, "CustomerReference", "Customer reference", issues)) ?? null;

  const rawLines = Array.isArray(order.OrderLine) ? order.OrderLine : [];
  if (rawLines.length === 0) issues.push("At least one order line is required.");
  const lines = rawLines
    .map((line, index) => mapLine(line, index + 1, issues))
    .filter((line): line is OrderLine => line !== undefined);

  const seen = new Set<number>();
  for (const { lineId } of lines) {
    if (seen.has(lineId)) issues.push(`Duplicate line ID: ${lineId}.`);
    seen.add(lineId);
  }

  if (
    issues.length > 0 ||
    orderId === undefined ||
    orderDate === undefined ||
    externalOrganizationId === undefined
  ) {
    throw validationError(issues);
  }

  const result = TransformedOrderSchema.safeParse({
    messageId: ctx.messageId,
    transformedAt: formatTimestamp(ctx.transformedAt),
    order: { orderId, externalOrganizationId, reference, orderDate, lines },
  });
  // Postcondition: the checks above should make this impossible. If it fails, it's our bug
  // (500 ServerError), not the partner's input (400).
  if (!result.success) throw serverError(result.error);
  return result.data;
}
