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
