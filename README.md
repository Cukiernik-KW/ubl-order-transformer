# ubl-order-transformer

Event-driven service that consumes Base64-encoded UBL 2.1 Order XML messages from Pub/Sub, transforms
them into a JSON order model and publishes the result.

> Work in progress. The full README (architecture, setup, running locally, Docker, deployment) is
> written at the end. Assumptions are recorded here as they are made.

## Assumptions

The specification leaves these points open. Each one is explained in [docs/DECISIONS.md](docs/DECISIONS.md).

### Input message (ADR-002)

- The spec's "Pub/Sub message" `{ messageId, timestamp, document }` is the **JSON carried in the Pub/Sub
  message data**. On a push subscription the document is therefore Base64-encoded twice.
- `orders.ubl.received` is the input **topic**. The service reads it through a push subscription.
- `timestamp` is optional and only logged. `messageId` must be a non-empty string.

### Decoding and parsing (ADR-004, ADR-005)

- Base64 must be standard and canonical. Whitespace and line breaks are allowed; base64url is rejected.
- The XML must be UTF-8. Any `DOCTYPE` is rejected.
- Namespace **prefixes** are ignored, and namespace URIs are not verified.

### Field mapping (ADR-006)

- `reference` (CustomerReference) and `comment` (Note) are optional and become `null` when missing.
  Several Notes are joined with a newline.
- `lineId` must be a positive integer. `itemId` is a string, so leading zeros are kept.
- `quantity` must be a positive decimal. `unitOfMeasure` (`@unitCode`) is required and never defaulted.
- `orderDate` accepts an optional timezone (`2025-01-01+01:00`) and is output as `YYYY-MM-DD`.
- `transformedAt` is UTC with seconds precision (`2026-07-27T12:01:00Z`).
- At least one order line is required, and line IDs must be unique. Elements that UBL allows only once
  are rejected when repeated.
- Validation errors list every issue in `details`; `message` is the first issue.

### Processing (ADR-008 – ADR-010)

- Duplicates are detected by the **application `messageId`**. A duplicate of a published message is not
  published again; its stored output is returned.
- A message that failed (for any reason) can be sent again with the same `messageId`.
- Permanent errors (invalid input) produce an error record on `orders.failed`. Transient errors are
  retried, first inside the service, then by Pub/Sub redelivery; when redelivery is exhausted, Pub/Sub's
  dead-letter policy moves the original message to `orders.failed`.
- The idempotency store in this version is in memory: it is per instance and does not survive restarts
  (see Production considerations).
