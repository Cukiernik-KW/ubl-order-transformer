import { XMLParser, XMLValidator } from "fast-xml-parser";
import { invalidXml } from "./errors.js";

export const ATTRIBUTE_PREFIX = "@_";
export const TEXT_NODE = "#text";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Bytes -> string. Invalid UTF-8 is rejected instead of silently becoming U+FFFD. BOM is stripped. */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw invalidXml(["Document is not valid UTF-8."]);
  }
}

// Elements that UBL allows 0..n times. Without this, a single occurrence parses as an object
// and two occurrences as an array, so an order with exactly one OrderLine would break `.map()`.
const ALWAYS_ARRAY = new Set(["Order.OrderLine", "Order.OrderLine.Note"]);

const parser = new XMLParser({
  // Partners may use any prefix (cbc:, ns0:, none). Trade-off: namespace URIs are not verified.
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: ATTRIBUTE_PREFIX,
  textNodeName: TEXT_NODE,
  // Keep every value a string ("00123" must not become 123); the mapper converts explicitly.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  // Decodes &amp; etc. DOCTYPE is rejected before parsing, so no custom entities can be declared.
  processEntities: true,
  // Also decodes numeric character references (&#233;), which are valid XML.
  // Side effect: HTML named entities such as &nbsp; are accepted too (lenient, harmless).
  htmlEntities: true,
  isArray: (_name, jpath) => ALWAYS_ARRAY.has(String(jpath)),
});

export type XmlNode = Record<string, unknown>;

/**
 * Spec Step 3: well-formedness check + parse into a plain object tree.
 * Root-element semantics (must be <Order>) are checked by the mapper.
 */
export function parseXml(xml: string): XmlNode {
  // UBL never needs a DTD. Rejecting it blocks XXE and entity-expansion ("billion laughs") attacks.
  if (/<!DOCTYPE/i.test(xml)) {
    throw invalidXml(["DOCTYPE declarations are not allowed."]);
  }

  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    const { msg, line, col } = validation.err;
    throw invalidXml([`${msg} (line ${line}, column ${col})`]);
  }

  const parsed = parser.parse(xml) as XmlNode;

  // XMLValidator accepts several top-level elements (e.g. "<a/><b/>"), which is not well-formed XML.
  // Two roots with the same name collapse into one key holding an array.
  const roots = Object.entries(parsed);
  if (roots.length !== 1 || Array.isArray(roots[0]?.[1])) {
    throw invalidXml(["Document must have exactly one root element."]);
  }
  return parsed;
}
