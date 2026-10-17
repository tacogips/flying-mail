import { classifyError } from "../graphql/errors";

export type McpToolErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_USER_INPUT"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "UNAUTHENTICATED"
  | "INTERNAL_ERROR";

export interface McpToolErrorResult {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly structuredContent: {
    readonly error: {
      readonly code: McpToolErrorCode;
      readonly message: string;
      readonly field?: string;
    };
  };
  readonly isError: true;
}

export function toolErrorResult(err: unknown): McpToolErrorResult {
  const classified = classifyError(err);
  const code: McpToolErrorCode =
    classified.code === "INTERNAL_SERVER_ERROR"
      ? "INTERNAL_ERROR"
      : classified.code;
  const message =
    code === "INTERNAL_ERROR" ? "Internal server error" : classified.message;
  if (code === "INTERNAL_ERROR") console.error(err);
  const error =
    classified.field === undefined
      ? { code, message }
      : { code, message, field: classified.field };
  return {
    content: [{ type: "text", text: `Error ${code}: ${message}` }],
    structuredContent: { error },
    isError: true,
  };
}
