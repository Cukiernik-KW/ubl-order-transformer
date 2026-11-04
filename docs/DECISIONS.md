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

---

## ADR-007: Ports and adapters (hexagonal-lite)

**Context.** The same processing logic must run against real Pub/Sub on Cloud Run, against an in-memory
broker locally (the spec requires a local simulation), and in fast, deterministic tests.

**Decision.** The processor depends only on three small interfaces (ports):

- `Publisher.publish(topic, json, attributes)`;
- `IdempotencyStore.tryClaim / complete / release`;
- `Clock.now()`.

Adapters implement them:

- `PubSubPublisher`: the real client, ADC auth, `PUBSUB_EMULATOR_HOST` honoured by the library;
- `InMemoryBroker`: publisher plus a push-style subscription with redelivery and dead-lettering;
- `InMemoryIdempotencyStore`.

The adapters are wired once, at startup. The idempotency port is async even though the in-memory version
is synchronous, because real implementations (Firestore, Redis) are remote.

**Alternatives.**

- **Calling `@google-cloud/pubsub` directly from the processor:** less code, but tests then need the
  emulator or module mocks.
- **A DI container:** overkill for three dependencies; plain constructor and function injection is enough.

**Consequences.**

- Domain and pipeline tests run in milliseconds with no network.
- `PubSubPublisher` itself is tested only with a fake client. The real wire behaviour is covered by the
  end-to-end test on GCP.

---

## ADR-008: Processing outcomes and dead-lettering

**Context.** Every message must end in a known state, and the HTTP layer needs that state to choose a
status code. This matters most for push: Pub/Sub treats any non-2xx response as a nack and redelivers.

**Decision.** `process()` returns a discriminated union instead of throwing:

| Outcome       | Meaning                                                          | DLQ                                                             |
| ------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `published`   | output published, key marked completed                           | –                                                               |
| `duplicate`   | key already completed; stored output returned, nothing published | –                                                               |
| `in-progress` | same key being processed concurrently                            | –                                                               |
| `rejected`    | permanent error (bad input)                                      | app publishes an error record                                   |
| `failed`      | transient error after retries                                    | none from the app; the platform's dead-letter policy handles it |

- **App DLQ record:** `{ messageId, failedAt, error: { code, message, details }, originalMessage }` with
  attributes `failureSource=app`, `errorCode` and `messageId` (when known). `originalMessage` makes replay
  possible.
- **Messages dead-lettered by the platform** (after `max_delivery_attempts`) are the raw original
  message. They carry Pub/Sub's `CloudPubSubDeadLetterSource*` attributes and no `failureSource`, so
  consumers of `orders.failed` can tell the two shapes apart.
- **If publishing the DLQ record itself fails**, the result is `rejected` with `deadLettered: false` and
  an ERROR log. The push endpoint then answers 500, so the message is redelivered and the platform DLQ
  still catches it. `/messages` still answers 400, because the caller's input is still invalid.

**Alternatives.**

- **Throwing and mapping exceptions in the HTTP layer:** the outcomes `duplicate` and `in-progress` are
  not errors, and a union lets the compiler check that every case is handled.
- **Dead-lettering transient failures from the app:** the message might succeed on redelivery, so a
  "failed" record would be a false positive.

**Consequences.** On the push path, every accepted message ends in exactly one of `orders.transformed` or
`orders.failed`.

---

## ADR-009: Retries: two layers, one in the process

**Context.** Publishing can fail transiently. Pub/Sub also redelivers nacked push messages.
`@google-cloud/pubsub` has its own built-in publish retry, which by default can run for minutes and
could outlive the push subscription's ack deadline. Pub/Sub would then redeliver the message while the
first attempt is still running.

**Decision.**

- **Layer 1, in the app:** `withRetry` uses exponential backoff with **full jitter**
  (`random() × min(maxDelay, base × 2^(n-1))`).
  - Only transient errors are retried. A permanent `AppError` fails immediately.
  - Unknown errors count as transient.
  - Configured by `PUBLISH_MAX_ATTEMPTS` and `PUBLISH_RETRY_BASE_MS`.
- **The library's retry is disabled** (`gaxOpts: { retry: null }`, verified in the google-gax source),
  with a per-attempt timeout (`PUBLISH_TIMEOUT_MS`, 5 s). The worst-case in-app budget
  (3 × 5 s + backoff) stays below the 60 s ack deadline set in infra.
- **Layer 2, the platform:** the subscription's `retry_policy` (exponential redelivery) plus
  `dead_letter_policy.max_delivery_attempts`.
- **`sleep` and `random` are injected**, so retry tests are instant and deterministic.

**Alternatives.**

- **Keeping the library retry:** that adds a hidden third layer with an unbounded-looking budget.
- **"Equal" jitter or no jitter:** without jitter, many instances retry in lockstep (thundering herd).
  Full jitter spreads the load best.

**Consequences.** Exactly two retry layers to reason about, with a known worst-case latency per delivery.

---

## ADR-010: Idempotency

**Context.** Pub/Sub push delivery is at-least-once, and partners may resend. The spec bonus asks that
duplicates do not produce duplicate outputs.

**Decision.**

- **Key: the application `messageId`.** It is not the Pub/Sub message id, because a partner re-publishing
  the same message gets a new Pub/Sub id but keeps its own. It is not the `orderId` either: that would be
  business-level dedupe, which is a different question (an order can legitimately be resent with
  changes).
- **Claim right after Step 1** (once `messageId` is known):
  - a completed key returns `duplicate` with the stored output, so `/messages` can answer 200 with the
    same body;
  - a claimed key returns `in-progress`.
- **`complete()` only after a successful publish.** Any failure, permanent or transient, calls
  `release()`, so a redelivery or a corrected resend can be processed.
- **In-memory implementation:**
  - completed keys live for `IDEMPOTENCY_TTL_SECONDS`; claims live for 60 s, so a hung request cannot
    block a key forever;
  - expired entries are swept without timers;
  - check-and-set is atomic because there is no `await` between the read and the write.

**Alternatives.**

- **Firestore `create()` (fails if the document exists) or Redis `SET NX EX`:** the production choice.
  They are shared across instances and survive restarts.
- **Pub/Sub exactly-once delivery:** available only for pull subscriptions, not push.

**Consequences.**

- The in-memory store is per instance and lost on restart. With several Cloud Run instances, duplicates
  routed to different instances are not caught (documented, and a Production consideration).
- **Crash window:** if the process dies after publishing but before `complete()`, the redelivery
  publishes again. Output is therefore at-least-once, and downstream consumers must be idempotent (they
  can dedupe on the `messageId` attribute). The alternative is a transactional outbox.

---

## ADR-011: Structured logging

**Context.** The spec bonus asks for structured logging, correlation by `messageId` and processing
duration metrics. Cloud Run forwards stdout to Cloud Logging, which parses JSON lines.

**Decision.**

- **pino** writes JSON to stdout. The level is written as **`severity`** with Cloud Logging names
  (`INFO`, `WARNING`, `ERROR`…) and the text as **`message`**. There are no pid or hostname fields,
  because Cloud Run adds resource labels.
- **One child logger per message**, carrying `messageId`, `pubsubMessageId`, `deliveryAttempt` and
  `source`.
- **One summary line per message:** `outcome`, `durationMs`, `orderId`, `documentBytes` and, on failure,
  `errorCode`. This line is the basis for a log-based distribution metric (latency) and counter metrics
  (outcomes).
- **Durations use `performance.now()`**, a monotonic clock. The injectable `Clock` is business time
  (`transformedAt`) and may be fixed in tests.
- **The document is never logged** (size and possible personal data). Only byte size and `orderId`.

**Alternatives.**

- **`console.log` with JSON.stringify:** no levels, no child loggers.
- **OpenTelemetry metrics and traces:** the production upgrade, more setup than this assignment needs.

**Consequences.** One Cloud Logging query on `jsonPayload.messageId` shows a message's whole journey.

---

## ADR-012: Two HTTP entry points, and status codes vs Pub/Sub push semantics

**Context.**

- The spec asks for an "endpoint for validation" that returns 400/500 errors. It also asks the service
  to consume a Pub/Sub subscription and to run on Cloud Run, where the natural consumer is a **push
  subscription**.
- Pub/Sub push treats only 102, 200, 201, 202 and 204 as an ack. **Any other status, 400 included, is a
  nack**, and the message is redelivered with backoff until the dead-letter policy gives up. A 400 for
  broken XML would turn every bad message into a poison message that is retried pointlessly.

**Decision.**

- **`POST /messages`** takes the application message directly and follows the spec's contract exactly:
  - 200 with the transformed order (also for a duplicate, with the stored output);
  - 400 for bad input;
  - 500 for transient failures.
- **`POST /pubsub/push`** takes the push envelope and chooses statuses for ack/nack semantics:
  - published or duplicate → 200;
  - rejected **and** dead-lettered → **200** (ack; the message is safely on `orders.failed`);
  - rejected but the DLQ publish failed → 500;
  - transient failure → 500;
  - in progress → 409, so Pub/Sub redelivers later.
- **The push response body is the same JSON** as on `/messages`. Pub/Sub ignores it, but it helps when
  debugging.
- **Push edge cases:**
  - an invalid **envelope** returns 400 with no DLQ record (real Pub/Sub never sends one, so it is a
    misconfigured or foreign caller);
  - **`data` that is not JSON** (for example raw XML published instead of the app message) is bad
    partner content: it is rejected, dead-lettered with the raw text, and acked.
- **Extensions to the spec's error codes:**
  - `DuplicateInProgress` (409);
  - 413 for an oversized body (code `ValidationError`);
  - 404 `NotFound`.
- **Error bodies carry `details`** only when it adds information (several issues, or a parser position),
  so single-issue errors match the spec byte for byte.

**Alternatives.**

- **Always return the spec's 400 on push and let the dead-letter policy catch it:** simpler code, but
  every bad message is delivered `max_delivery_attempts` times, wastes instances and delays the DLQ by
  minutes. Rejected.
- **A single endpoint, with a push subscription in "no-wrapper" (payload unwrapping) mode:** Pub/Sub
  would POST the raw app message, so one handler could serve both cases. Rejected: the two callers need
  different status semantics (spec 400 versus ack-on-permanent), and wrapped mode gives `deliveryAttempt`
  and the Pub/Sub message id in the body.
- **A pull subscriber instead of push:** on Cloud Run, a long-running pull loop needs always-on CPU and
  minimum instances. Push lets Cloud Run scale to zero.

**Consequences.** Every message that reaches the push endpoint ends in exactly one of `orders.transformed`
or `orders.failed`. The HTTP mapping is a pure function per endpoint with an exhaustive `switch`.

---

## ADR-013: Runtime: configuration, health check, body handling, shutdown

**Context.** The service runs as a Cloud Run container. It is configured through environment variables,
gets SIGTERM before it is stopped, and receives bodies from Pub/Sub or from people using curl.

**Decision.**

- **Configuration** is validated once, at startup, with Zod (`loadConfig(env)`, a pure function). An
  invalid value stops the process with **every** problem listed (fail fast). Numbers are coerced from
  strings, and empty strings count as unset.
- **Health check at `GET /health`, not `/healthz`.** Cloud Run's frontend reserves some URL paths ending
  in `z`, so `/healthz` may never reach the container.
- **Bodies are parsed as JSON regardless of Content-Type.** `curl -d` sends form-urlencoded by default,
  which would otherwise produce an empty body and a misleading "Message is required.". This is safe:
  the service is behind IAM, and it has no cookies, so CSRF does not apply. An empty request is reported
  as "Message is required.".
- **Body limit:** `MAX_BODY_BYTES` (1 MB by default). The push path carries Base64 inside Base64
  (about ×1.78), so the XML limit is about 560 KB via push. Raise the limit together with Cloud Run
  memory if needed.
- **`createApp(deps)` builds the app without listening.** `server.ts` is the composition root: config,
  logger, adapters (`PUBLISHER=memory|pubsub`), processor, then `listen`.
- **Graceful shutdown on SIGTERM:**
  1. stop accepting connections;
  2. let in-flight requests finish;
  3. close idle keep-alive sockets;
  4. flush Pub/Sub batches;
  5. exit.

  A hard 9 s timeout applies, because Cloud Run kills the container about 10 s after SIGTERM.

- `x-powered-by` is disabled.

**Alternatives.**

- **Reading `process.env` wherever a value is needed:** typos then surface only on the first message.
- **Exiting immediately on SIGTERM:** in-flight messages would be nacked by the timeout, and batched
  publishes could be lost.

**Consequences.**

- `server.ts` is excluded from unit-test coverage (it is wiring and signals). It is verified by running
  the container.
- Signal handling cannot be exercised on Windows. It is tested in Docker (Stage 7).

---

## ADR-014: Testing strategy

**Context.** The spec asks for unit tests (Base64, XML parsing, mapping, validation) and integration tests
(valid message, malformed message, publishing, error handling). The critical behaviour is the
interaction between our status codes and Pub/Sub redelivery, which cannot be exercised without a broker.

**Decision.**

- **Unit tests** (`test/unit`) cover pure functions and single components:
  - domain: Base64, XML, mapper, message validation, errors;
  - retry, idempotency store, broker, processor, config, push envelope;
  - `PubSubPublisher`, against a fake client (no network).
- **Integration tests** (`test/integration`) run the **real Express app, processor, retry and
  idempotency**. Only the transport is in memory. **None of our own code is mocked.**
  - `/messages` and `/pubsub/push` through supertest, with no open port.
  - **The full push loop:** a test helper subscribes the `InMemoryBroker` to the input topic and POSTs
    every delivery to `/pubsub/push`. It acks on 102/200/201/202/204, redelivers otherwise, and
    dead-letters after `maxDeliveryAttempts`, which mirrors the platform behaviour.
- **Test doubles we do use:**
  - a fixed `Clock`, for golden outputs;
  - injected `sleep` and `random`, so retries are instant;
  - `broker.failPublishes(topic, n)` to simulate outages;
  - a gated publisher, for the concurrency test.
- **Key behaviours are tested as stated in the docs:**
  - a poison message is delivered exactly once;
  - a long outage gives 5 deliveries × 3 in-app attempts = 15 publish attempts, then the platform
    dead-letters the original;
  - **the invariant itself:** a mixed batch is sent, and every message is checked to land in exactly one
    of `orders.transformed` / `orders.failed`.
- **Golden output:** `test/fixtures/expected-output.sample.json` is the spec's example output and is
  compared byte for byte (the fixed clock gives `transformedAt`).
- **Mutation checks** were done by hand on key lines, to confirm that tests fail when the behaviour
  breaks:
  - removing the Base64 round-trip, `isArray`, the claim `release()` or `complete()`;
  - retrying permanent errors;
  - answering 400 instead of 200 for a dead-lettered push.
- **Coverage thresholds of 90%** (lines, branches, functions, statements) fail the build. `server.ts` is
  excluded from coverage.
- **Transport-level errors on `/messages`** (body not JSON, body too large) return 400/413 **without** a
  DLQ record: the message never entered the pipeline, and the caller still holds it. This corrects the
  original plan, which listed "non-JSON body → `orders.failed`".

**Alternatives.**

- **Mocking the processor in the HTTP tests:** faster to write, but it would not catch mismatches between
  layers. The `details` duplication bug was found by running the real stack.
- **Testing against the Pub/Sub emulator:** more realistic transport, but slower and it needs Java or
  Docker in CI. It is kept as an option, because the client honours `PUBSUB_EMULATOR_HOST`. The real
  service is exercised by the end-to-end test on GCP.

**Consequences.**

- About 200 tests run in about 2 s with no network.
- What is NOT covered by automated tests until the GCP end-to-end test:
  - the real Pub/Sub client on the wire;
  - OIDC authentication;
  - IAM;
  - Cloud Run signal handling.

---

## ADR-015: Local simulation and sample messages

**Context.** The spec requires "a local mechanism to simulate messages" (a local JSON message file, an
in-memory publisher/subscriber) and documentation on "how to publish test messages", for reviewers who
have no Pub/Sub project.

**Decision.**

- **`samples/`** holds the spec's XML (`order.xml`), the app messages built from it (valid, invalid
  Base64, invalid XML, missing Order ID), a push envelope and `expected-output.json`.
  - The messages are **generated** by `npm run samples` (deterministic ids and timestamps), never edited
    by hand.
  - **`expected-output.json` is NOT generated.** It is the spec's example output, so golden tests compare
    the code against the spec and not against itself.
  - Tests read `samples/` directly, so the published examples are tested examples.
- **`npm run simulate`** runs the whole flow in one process:
  - partner publishes to `orders.ubl.received`;
  - a local push subscription delivers to the processor;
  - the result goes to `orders.transformed` or `orders.failed`.

  The subscription (`src/local/pushSubscription.ts`) does not use HTTP, but uses the **same** envelope
  decoding and the **same** status mapping as `POST /pubsub/push`, so ack/nack decisions are identical.
  `--fail-publishes` and `--max-delivery-attempts` demonstrate retries and dead-lettering live.

- **`npm run publish:local`** POSTs a sample to a running service (`/messages`, or `/pubsub/push` with
  `--push` or for an envelope file). With `--url` and `--token` the same command targets Cloud Run.
  It uses the built-in `fetch`, so there is no new dependency.
- **`npm run encode`** turns any XML file into an app message or a push envelope.
- **`GET /debug/topics/:name`** is **registered only in memory mode**. With `PUBLISHER=pubsub` the route
  does not exist, so it cannot be exposed by mistake.
- **The message builders live in `src/local/messages.ts`** and are shared by the scripts and the tests.
- **The spec's sample XML had CRLF line endings.** It is stored with LF (`.gitattributes eol=lf`), and the
  samples are generated from the LF file, so the Base64 in the samples matches the file on every OS.

**Alternatives.**

- **Running `simulate` through HTTP (Express plus fetch):** more moving parts and a port to manage. The
  HTTP path is already covered by the integration tests and by `publish:local`.
- **The Pub/Sub emulator for local runs:** more realistic, but it needs Java or Docker and skips
  dead-letter policies, which is what the simulation is meant to show.

**Consequences.**

- A reviewer can see the full flow, including retries and the DLQ, in seconds, without GCP.
- In memory mode, published messages accumulate in memory. That is fine for local use, and this mode is
  never used on Cloud Run.

---

## ADR-016: Container image and CI

**Context.** Cloud Run runs a container that must listen on `$PORT`, start fast, and stop cleanly within
about 10 s of SIGTERM. The spec asks for `docker build` / `docker run`. CI should block broken changes
and avoid supply-chain risk.

**Decision.**

- **Multi-stage Dockerfile.**
  - The `build` stage runs `npm ci` (with dev dependencies) and `tsc`.
  - The `runtime` stage runs `npm ci --omit=dev` and copies only `dist/`.
  - The final image has no TypeScript, no tests and no dev tools: `/app` holds only `dist`,
    `node_modules` and `package*.json`, which the smoke test checks.
- **Base image `node:24-slim`, pinned by digest**, for reproducible builds. Bumps are deliberate, ideally
  through Dependabot or Renovate.
- **Runs as the unprivileged `node` user.** A compromised process can't modify the image filesystem or
  escalate as root.
- **The exec-form `CMD ["node", "dist/server.js"]`** makes node PID 1, so it receives SIGTERM directly.
  The shell form would put `/bin/sh` in between, and the signal would not be forwarded.
- **`npm ci`, not `npm install`:** an exact install from the lockfile that fails if it disagrees with
  `package.json`, so CI and the image get what was tested.
- **`.dockerignore` is an allowlist** (`*`, then `!package*.json`, `!tsconfig*.json`, `!src/`). Nothing
  outside these files can reach the build context: no `.git`, no `.env`, no local notes.
- **`scripts/docker-smoke.sh`** runs the image and checks:
  - `/health`;
  - a valid sample returns 200 and the missing-Order-ID sample returns 400;
  - the process is not root;
  - the contents of `/app`;
  - **graceful shutdown**: `docker stop` sends SIGTERM, and the process must exit with code 0 and log
    "Shutdown complete".

  The same script runs locally and in CI.

- **GitHub Actions (`ci.yml`):**
  - the `test` job runs `npm ci`, then lint, typecheck, format check, tests with 90% coverage thresholds,
    and `npm audit --omit=dev --audit-level=high`;
  - the `docker` job runs the build and the smoke test.
  - Supporting choices:
    - `permissions: contents: read` and `persist-credentials: false` keep the token minimal;
    - **third-party actions are pinned to full commit SHAs**, because a tag can be moved to malicious
      code (as in the 2025 `tj-actions/changed-files` incident);
    - Docker is driven by plain `docker` commands rather than more actions, so fewer third-party
      actions are involved;
    - concurrency cancels superseded runs.
- **CI does not push images.** Publishing to Artifact Registry, tagged with the git SHA, happens in the
  deployment stage.

**Alternatives.**

- **Distroless runtime image:** smaller, no shell, fewer CVEs; the production upgrade. Slim was kept for
  easier debugging (`docker exec … sh`).
- **Alpine:** small, but musl libc can cause subtle differences with native modules. There are no native
  modules here, but slim is the safer default.
- **Docker `HEALTHCHECK`:** Cloud Run ignores it and uses its own startup and liveness probes, so it is
  not added.

**Consequences.**

- The image is about 290 MB uncompressed, most of it the Node base image.
- The full pipeline runs in about 2 minutes, and a broken build, test, format or vulnerable production
  dependency blocks the merge.
