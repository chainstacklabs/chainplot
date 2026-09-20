import type { CommandError, ErrorCode } from "../cli/envelope.js";

export function commandError(
  code: ErrorCode,
  message: string,
  opts: {
    resource_id?: string | null;
    pointer?: string | null;
    retryable?: boolean;
    suggested_next?: string | null;
  } = {},
): CommandError {
  return {
    code,
    message,
    resource_id: opts.resource_id ?? null,
    pointer: opts.pointer ?? null,
    retryable: opts.retryable ?? false,
    suggested_next: opts.suggested_next ?? null,
  };
}

export function isCommandError(err: unknown): err is CommandError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "message" in err &&
    "resource_id" in err &&
    "pointer" in err &&
    "retryable" in err &&
    "suggested_next" in err
  );
}

/**
 * Readable text for anything thrown.
 *
 * `CommandError` is a plain object, not an `Error`, so the common
 * `err instanceof Error ? err.message : String(err)` renders it as
 * "[object Object]" and loses the diagnosis entirely.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}
