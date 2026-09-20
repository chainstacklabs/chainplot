export const SCHEMA_VERSION = 1 as const;

export type ErrorCode =
  | "validation"
  | "missing_credentials"
  | "unsupported_capability"
  | "policy_refused"
  | "source_inconsistent"
  | "transient_dependency"
  | "internal";

export interface CommandError {
  code: ErrorCode;
  message: string;
  resource_id: string | null;
  pointer: string | null;
  retryable: boolean;
  suggested_next: string | null;
}

export interface CommandResult<T = unknown> {
  schema_version: typeof SCHEMA_VERSION;
  ok: boolean;
  command: string;
  data: T | null;
  warnings: string[];
  error: CommandError | null;
}

export function okResult<T>(command: string, data: T): CommandResult<T> {
  return {
    schema_version: SCHEMA_VERSION,
    ok: true,
    command,
    data,
    warnings: [],
    error: null,
  };
}

export function failResult(
  command: string,
  error: CommandError,
): CommandResult<null> {
  return {
    schema_version: SCHEMA_VERSION,
    ok: false,
    command,
    data: null,
    warnings: [],
    error,
  };
}
