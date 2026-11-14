/** Exit codes from `design-docs/specs/command.md#exit-codes`. Distinct
 * codes for auth and authorization failures so a shell script can retry a
 * transient network problem without retrying a rejected credential. */
export enum ExitCode {
  Success = 0,
  GeneralError = 1,
  UsageError = 2,
  AuthError = 3,
  ForbiddenError = 4,
  NotFoundError = 5,
  NetworkError = 6,
}

export function exitCodeForGraphQLError(code: string): ExitCode {
  switch (code) {
    case "UNAUTHENTICATED":
      return ExitCode.AuthError;
    case "FORBIDDEN":
      return ExitCode.ForbiddenError;
    case "NOT_FOUND":
      return ExitCode.NotFoundError;
    default:
      return ExitCode.GeneralError;
  }
}

/** Carries the exit code its failure should produce, so `main.ts` needs no
 * knowledge of what went wrong. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = ExitCode.GeneralError,
  ) {
    super(message);
    this.name = "CliError";
  }
}
