export type ErrorCode = "ValidationError" | "InvalidBase64" | "InvalidXml" | "ServerError";

/**
 * The single error type that crosses layer boundaries.
 * `permanent` drives the retry/DLQ decision: permanent errors are never retried
 * (the same input will always fail), transient ones may succeed on a later attempt.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly permanent: boolean;
  readonly details: readonly string[];

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      httpStatus: number;
      permanent: boolean;
      details?: readonly string[];
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.permanent = options.permanent;
    this.details = options.details ?? [];
  }
}

/** `message` is the first issue (spec format); `details` carries all of them. */
export function validationError(issues: readonly string[]): AppError {
  const [first = "Validation failed."] = issues;
  return new AppError("ValidationError", first, {
    httpStatus: 400,
    permanent: true,
    details: issues,
  });
}

export function invalidBase64(): AppError {
  return new AppError("InvalidBase64", "Document is not a valid Base64 string.", {
    httpStatus: 400,
    permanent: true,
  });
}

export function invalidXml(details: readonly string[] = []): AppError {
  return new AppError("InvalidXml", "Message could not be parsed from XML to JSON.", {
    httpStatus: 400,
    permanent: true,
    details,
  });
}

/** Unknown failures are treated as transient: redelivery may succeed, and the platform DLQ caps it. */
export function serverError(cause?: unknown): AppError {
  return new AppError("ServerError", "An unexpected error occurred.", {
    httpStatus: 500,
    permanent: false,
    cause,
  });
}
