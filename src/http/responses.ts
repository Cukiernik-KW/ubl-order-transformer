import type { AppError } from "../domain/errors.js";
import type { ProcessResult } from "../pipeline/processor.js";

export interface HttpResponse {
  status: number;
  body: unknown;
}

/**
 * The spec's error body. `details` is added only when it says more than `message`
 * (several issues, or parser position info), so single-issue errors match the spec exactly.
 */
export function errorBody(error: AppError, messageId: string | null) {
  const { details } = error;
  const addsInformation =
    details.length > 1 || (details.length === 1 && details[0] !== error.message);
  return {
    error: error.code,
    message: error.message,
    messageId,
    ...(addsInformation ? { details } : {}),
  };
}

function inProgressBody(messageId: string) {
  return {
    error: "DuplicateInProgress",
    message: "A message with this messageId is already being processed.",
    messageId,
  };
}

/** POST /messages: the spec's HTTP contract (400 for bad input, 500 for our failures). */
export function toMessagesResponse(result: ProcessResult): HttpResponse {
  switch (result.outcome) {
    case "published":
    case "duplicate":
      return { status: 200, body: result.output };
    case "in-progress":
      return { status: 409, body: inProgressBody(result.messageId) };
    case "rejected":
      return { status: result.error.httpStatus, body: errorBody(result.error, result.messageId) };
    case "failed":
      return { status: 500, body: errorBody(result.error, result.messageId) };
  }
}

/**
 * POST /pubsub/push: Pub/Sub acks only 2xx (102, 200, 201, 202, 204) and redelivers everything else.
 * Bad input that is already on the DLQ is acked (200), or it would be redelivered forever.
 * Anything not safely stored somewhere is nacked, so Pub/Sub retries and finally dead-letters it.
 */
export function toPushResponse(result: ProcessResult): HttpResponse {
  switch (result.outcome) {
    case "published":
    case "duplicate":
      return { status: 200, body: result.output };
    case "in-progress":
      return { status: 409, body: inProgressBody(result.messageId) };
    case "rejected":
      return {
        status: result.deadLettered ? 200 : 500,
        body: errorBody(result.error, result.messageId),
      };
    case "failed":
      return { status: 500, body: errorBody(result.error, result.messageId) };
  }
}
