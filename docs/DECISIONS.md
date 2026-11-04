# Architecture Decision Records (ADR-lite)

Each entry: Context / Decision / Alternatives / Consequences. Newest at the bottom.

---

## ADR-001: Runtime and tooling

**Context.** A small, event-driven Node.js service that has to run on Cloud Run and be easy to review. The
toolchain should catch real bugs (unchecked `undefined`, forgotten `await`) without adding much configuration.

**Decision.**

- **Node.js 24** (active LTS) and **TypeScript in strict mode** with ESM (`"type": "module"`,
  `module: NodeNext`).
- Extra compiler checks beyond `strict`:
  - `noUncheckedIndexedAccess`: the parsed XML is a tree of possibly-missing nodes, so `lines[0]` is typed
    `T | undefined` and has to be handled.
  - `verbatimModuleSyntax`: type-only imports are explicit, so ESM output is predictable.
- Two tsconfigs:
  - `tsconfig.json` type-checks src, tests and scripts (`noEmit`).
  - `tsconfig.build.json` compiles only `src/` to `dist/`.
- **tsx** runs TypeScript directly for `dev` and `scripts/`. The production container runs compiled JS
  (`node dist/server.js`), not tsx.
- **ESLint** (flat config) with `typescript-eslint` type-checked rules. The main reason is
  `no-floating-promises` / `no-misused-promises`: a publish call without `await` would silently drop errors.
  `eslint-config-prettier` turns off the style rules that Prettier owns.
- **Prettier** with a near-default config (`printWidth: 100`).
- **Vitest** for unit and integration tests (native ESM + TS, no transpile config) with **v8** coverage on
  `src/` only.
- `.gitattributes` forces LF line endings. Development happens on Windows, but the code runs in Linux
  containers and CI, where CRLF breaks shell scripts.
- Only dev dependencies at this stage. Runtime dependencies are added in the stage that first needs them,
  each with a one-line justification.

**Alternatives.**

- **Node 22:** still LTS, but in maintenance. 24 is the current active LTS.
- **Node's native type stripping instead of tsx:** removes one dependency, but needs `.ts` extensions in
  imports plus extra compiler flags. That is more configuration than one dev dependency saves.
- **Jest:** needs extra ESM/TS transform setup. Vitest works out of the box.
- **Biome instead of ESLint + Prettier:** a single fast tool, but it has no type-aware rules equivalent to
  `no-floating-promises`.

**Consequences.**

- `npm audit` reports moderate advisories in `minimatch`, a transitive dependency of the ESLint toolchain.
  They affect dev tooling only, and the suggested "fix" downgrades ESLint to v4, so it is not applied. CI
  audits production dependencies only (`npm audit --omit=dev`), which is what ships in the image.
- `passWithNoTests` is enabled temporarily so the scaffold is green. It is removed in Stage 2.

---

## ADR-002: Input message interpretation and Pub/Sub naming

**Context.** The assignment shows a "Pub/Sub message" `{ messageId, timestamp, document }` with `document` =
Base64(UBL XML), and says the service should "subscribe to `orders.ubl.received`". It also asks for an HTTP
endpoint that returns 400/500 errors. There are two ways to read the message:

- **(a)** It is the application payload carried inside the Pub/Sub message `data`.
- **(b)** It is a simplified view of the Pub/Sub message itself: `data` = Base64(XML),
  `messageId` = the Pub/Sub id, `timestamp` = `publishTime`.

**Decision.**

- **Interpretation (a).** The partner publishes the JSON `{ messageId, timestamp, document }` as the
  message data.
  - On a push subscription, Pub/Sub wraps it in its envelope and Base64-encodes `data`, so the document is
    Base64-encoded twice: `envelope.message.data` → app JSON → `document` → XML.
- `orders.ubl.received` is the **topic** the partner publishes to. The service consumes it through a push
  subscription named `orders.ubl.received.transformer`. Because Pub/Sub calls the service, the app does
  not need the subscription name as configuration.
- `timestamp` is optional, kept as a string, and only logged. Step 1 of the spec does not require it, and
  rejecting a malformed timestamp would add a failure mode the spec does not ask for.

**Alternatives.**

- **Interpretation (b).** Under (b), real Pub/Sub could never produce `InvalidBase64` (Pub/Sub does the
  encoding itself), and the error contract's `messageId` would be a broker id, not the partner's. Reading
  (a) is the one consistent with the spec's error contract.

**Consequences.**

- A partner-controlled `messageId` exists independently of Pub/Sub's own id. This becomes the idempotency
  key (see a later ADR).
- Base64 is decoded twice on the push path, so payload size grows about 1.78× on the wire (documented with
  the body-size limit).
- This is an assumption and is listed in the README "Assumptions" section.

---

## ADR-003: Error model

**Context.** The spec defines four error bodies (`ValidationError`, `InvalidBase64`, `InvalidXml`,
`ServerError`). The pipeline must also decide, for every failure, whether retrying can help.

**Decision.**

- **One `AppError` class** with `code`, `httpStatus`, `permanent` and `details[]`, built through small
  factories that hold the spec's exact messages.
- `permanent` drives retry/DLQ handling:
  - The three 400 errors are permanent: the same input always fails.
  - `ServerError` is transient. An unknown failure might succeed on redelivery, and the platform's
    dead-letter policy limits how many times that is tried.
- `ValidationError.message` is the first issue (the spec format, e.g. "Order ID is required."). `details`
  lists every issue, so a partner can fix all of them in one round trip.
- `messageId` is **not** stored on the error. The HTTP/pipeline layer adds it, so the domain functions
  (Base64, XML) stay independent of the message envelope.

**Alternatives.**

- **One subclass per error code:** more types without more behaviour.
- **Result types instead of exceptions:** explicit, but noisy in TypeScript without a library.
- **Failing fast on the first validation issue:** simpler, but partners then fix one field per round trip.

**Consequences.** The edge layer maps `AppError` to the response and treats any other exception as
`serverError(cause)`. The `cause` is logged and never returned in a response.

---

## ADR-004: Strict Base64 decoding

**Context.** `Buffer.from(s, "base64")` never throws. It skips characters outside the alphabet and stops at
padding, so garbage input "decodes" to arbitrary bytes and would only fail later as `InvalidXml`, with a
misleading error code.

**Decision.** `decodeBase64Strict` works in four steps:

1. Strip whitespace. MIME-style line breaks are accepted.
2. Require the standard alphabet, at most two `=` at the end, and `length % 4 === 0`.
3. Decode.
4. **Round-trip**: the decoded bytes must re-encode to exactly the input. This rejects non-canonical
   encodings such as `QR==`.

Empty output is rejected as well. base64url (`-`, `_`) is rejected.

**Alternatives.**

- **Regex only:** misses non-canonical trailing bits.
- **A third-party Base64 library:** a dependency for about ten lines of code.
- **Accepting base64url:** the spec says "Base64", and Pub/Sub uses standard Base64.

**Consequences.** Invalid input fails at the right step, with the right code. The cost is one extra
encode per message (O(n), negligible next to XML parsing).

---

## ADR-005: XML parsing and hardening (fast-xml-parser)

**Context.** We need a well-formedness check, a parse of UBL 2.1 Order into a plain object, and safety
against hostile XML.

**Decision.** Use `fast-xml-parser` v5: pure JS, no native build, a built-in validator, and no fetching of
external DTDs.

- **Reject any `<!DOCTYPE`** before parsing. UBL never needs a DTD, and rejecting it blocks XXE (external
  entities reading files or URLs) and entity expansion ("billion laughs").
- **Configuration:**
  - `removeNSPrefix` so that any prefix (`cbc:`, `ns0:`, none) maps the same way;
  - `isArray` for `OrderLine` and `Note` (0..n elements; otherwise a single occurrence becomes an object);
  - `parseTagValue: false` so values stay strings (`"00123"` must not become `123`); the mapper converts
    explicitly;
  - `ignoreAttributes: false` to read `unitCode`.
- **Entities:** `processEntities: true` decodes `&amp;` and friends. It is safe because DOCTYPE, and with it
  any custom entity, is already rejected. `processEntities: false` was tested and leaves `&amp;` literally
  in the values. `htmlEntities: true` also decodes numeric references (`&#233;`), which are valid XML. Side
  effect: HTML named entities such as `&nbsp;` are accepted (lenient, harmless).
- **Gaps in the validator, covered by our own checks:**
  - several root elements (`<a/><b/>`, or two `<Order>`s) are reported as valid, so we require exactly
    one root;
  - unbound prefixes are accepted, which is acceptable because prefixes are stripped anyway.
- **Encoding:** input bytes must be valid **UTF-8** (`TextDecoder` with `fatal: true`; a BOM is stripped).
  Other declared encodings are not supported.

**Alternatives.**

- `libxmljs2`: native, supports XSD validation, but needs a native build and has a history of XXE.
- `xml2js`: has no validator.
- `@xmldom/xmldom` + `xpath`: namespace-aware, so it checks namespace URIs and not just local names, but
  it is more code. This is the first upgrade if strict namespace checking is required.

**Consequences.**

- **Namespace URIs are not verified.** An element with the right local name in a wrong namespace is
  accepted.
- No XSD validation. The mapper enforces only the fields we output.

---

## ADR-006: Mapping rules (UBL -> output JSON)

**Context.** The spec gives the field mapping and one example, but not types, optionality or edge cases.

**Decision.** These rules are assumptions, also listed in the README:

- **Strings, trimmed:** `orderId`, `externalOrganizationId`, `itemId`. `itemId` stays a string to keep
  leading zeros.
- **`reference` and `comment` are optional**; missing or empty values become `null`. Several `Note`s are
  joined with `"\n"`.
- **`lineId` is a positive integer**, a number as in the spec example. Leading zeros are accepted
  (`"01"` → `1`), and duplicates are compared numerically. Open question: UBL IDs are strings.
- **`quantity` is a positive decimal**, checked with a regex **before** `Number()`, because `Number()`
  accepts `""` (0), `"1e3"` (1000) and `"0x10"` (16).
- **`unitOfMeasure`** (`@unitCode`) is required and never defaulted. It is not checked against the UN/ECE
  Rec 20 code list.
- **`orderDate`** accepts `xsd:date` with an optional timezone and outputs `YYYY-MM-DD`. Impossible dates
  such as `2025-02-30` are rejected.
- **`transformedAt`** is ISO 8601 UTC with seconds precision, matching the spec example
  (`2026-07-27T12:01:00Z`).
- **Elements UBL allows only once** (`ID`, `IssueDate`, …) are rejected when repeated, instead of guessing
  which one to use.
- **Line errors name the line by position** (`Order line 2: …`), because the line ID itself may be the
  invalid field.
- **`messageId` must be a non-empty string.** A number is rejected, because the spec shows a string.
- **Output schema as a postcondition:** the mapper's result is parsed with `TransformedOrderSchema` (Zod).
  This also fixes the key order to match the spec. If it fails, it is a bug in our code (500), not invalid
  partner input (400).

**Alternatives.**

- **`lineId` as a string**, which is UBL-faithful but differs from the spec example.
- **Mapping everything declaratively with Zod transforms:** less code, but per-line messages that name the
  line are harder to produce.

**Consequences.**

- Very large or very precise quantities are limited to IEEE-754 double precision (acceptable for order
  quantities).
- A change in output shape needs a schema change, which makes the change explicit.
