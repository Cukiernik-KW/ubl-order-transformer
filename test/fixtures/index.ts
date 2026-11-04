import { readFileSync } from "node:fs";
import { createAppMessage } from "../../src/local/messages.js";

export function readFixture(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

/** Files from samples/: the published examples are the test data, so they are tested too. */
export function readSample(name: string): string {
  return readFileSync(new URL(`../../samples/${name}`, import.meta.url), "utf8");
}

export interface LineSpec {
  notes?: string[];
  /** `null` omits the element. */
  id?: string | null;
  quantity?: string | null;
  unitCode?: string | null;
  itemId?: string | null;
}

export interface OrderSpec {
  /** `null` omits the element. */
  id?: string | null;
  issueDate?: string | null;
  customerReference?: string | null;
  accountId?: string | null;
  lines?: LineSpec[];
}

const el = (tag: string, value: string | null | undefined): string =>
  value === null || value === undefined ? "" : `<${tag}>${value}</${tag}>`;

function lineXml(line: LineSpec): string {
  const { notes = [], id = "1", quantity = "1", unitCode = "EA", itemId = "100100" } = line;
  const unitAttr = unitCode === null ? "" : ` unitCode="${unitCode}"`;
  const quantityXml =
    quantity === null ? "" : `<cbc:Quantity${unitAttr}>${quantity}</cbc:Quantity>`;
  return `
  <cac:OrderLine>
    ${notes.map((note) => el("cbc:Note", note)).join("")}
    <cac:LineItem>
      ${el("cbc:ID", id)}
      ${quantityXml}
      <cac:Item><cac:SellersItemIdentification>${el("cbc:ID", itemId)}</cac:SellersItemIdentification></cac:Item>
    </cac:LineItem>
  </cac:OrderLine>`;
}

/** Small UBL Order builder for field-level test variants. Defaults produce a valid one-line order. */
export function buildOrderXml(spec: OrderSpec = {}): string {
  const {
    id = "12347",
    issueDate = "2025-01-01",
    customerReference = "test-order",
    accountId = "1234567",
    lines = [{}],
  } = spec;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Order xmlns="urn:oasis:names:specification:ubl:schema:xsd:Order-2"
       xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
       xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
  ${el("cbc:ID", id)}
  ${el("cbc:IssueDate", issueDate)}
  ${el("cbc:CustomerReference", customerReference)}
  <cac:BuyerCustomerParty>${el("cbc:SupplierAssignedAccountID", accountId)}</cac:BuyerCustomerParty>
  ${lines.map(lineXml).join("")}
</Order>`;
}

/** The application message the partner publishes (fixed timestamp for stable tests). */
export function appMessage(xml: string, messageId = "7a1e78c9") {
  return createAppMessage(xml, { messageId, timestamp: "2026-07-27T12:00:00Z" });
}
