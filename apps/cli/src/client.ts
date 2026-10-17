import type { CliConfig } from "./config";
import { parseEndpointUrl } from "./endpoint";
import { CliError, ExitCode, exitCodeForGraphQLError } from "./exit-codes";

export interface CliGraphQLClient {
  request<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  uploadAttachment(
    fileName: string,
    contentType: string,
    bytes: Uint8Array,
  ): Promise<{ readonly id: string; readonly fileName: string }>;
}

interface GraphQLResponse<T> {
  readonly data?: T;
  readonly errors?: readonly {
    readonly message: string;
    readonly extensions?: { readonly code?: string };
  }[];
}

export function requireEndpoint(config: CliConfig): string {
  if (config.endpoint === null || config.endpoint.length === 0) {
    throw new CliError(
      "No endpoint configured. Pass --endpoint, set FLYING_MAIL_ENDPOINT, or run `flying-mail config set endpoint <url>`.",
      ExitCode.UsageError,
    );
  }
  // Validated before use so a typo'd or plaintext scheme fails here, not
  // after the bearer token has already been sent.
  parseEndpointUrl(config.endpoint);
  return config.endpoint.replace(/\/+$/, "");
}

/** HTTP statuses that the API uses for transient failures, mapped to the
 * same codes it reports in GraphQL error extensions. */
function transientCodeForStatus(status: number): string | undefined {
  if (status === 429) return "RATE_LIMITED";
  if (status === 503) return "SERVICE_UNAVAILABLE";
  return undefined;
}

function authHeaders(config: CliConfig): Record<string, string> {
  return config.apiKey === null || config.apiKey.length === 0
    ? {}
    : { authorization: `Bearer ${config.apiKey}` };
}

function networkError(endpoint: string, error: unknown): CliError {
  return new CliError(
    `Could not reach ${endpoint}: ${
      error instanceof Error ? error.message : "network error"
    }`,
    ExitCode.NetworkError,
  );
}

/** Thin GraphQL client that turns every failure into a `CliError` carrying
 * the right exit code, so command handlers never deal with transports. */
export function createCliClient(config: CliConfig): CliGraphQLClient {
  const endpoint = requireEndpoint(config);

  return {
    async request<T>(
      query: string,
      variables?: Record<string, unknown>,
    ): Promise<T> {
      let response: Response;
      try {
        response = await fetch(`${endpoint}/graphql`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(config),
          },
          body: JSON.stringify(
            variables === undefined ? { query } : { query, variables },
          ),
        });
      } catch (error) {
        throw networkError(endpoint, error);
      }

      let payload: GraphQLResponse<T>;
      try {
        payload = (await response.json()) as GraphQLResponse<T>;
      } catch {
        throw new CliError(
          `Unexpected non-JSON response (HTTP ${response.status})`,
          response.status === 401 ? ExitCode.AuthError : ExitCode.GeneralError,
          transientCodeForStatus(response.status),
        );
      }

      const firstError = payload.errors?.[0];
      if (firstError !== undefined) {
        throw new CliError(
          firstError.message,
          exitCodeForGraphQLError(firstError.extensions?.code ?? ""),
          firstError.extensions?.code,
        );
      }
      if (payload.data === undefined) {
        throw new CliError("Response contained no data", ExitCode.GeneralError);
      }
      return payload.data;
    },

    async uploadAttachment(fileName, contentType, bytes) {
      const form = new FormData();
      form.set(
        "file",
        new File([bytes as unknown as Blob], fileName, {
          type: contentType,
        }),
      );
      let response: Response;
      try {
        response = await fetch(`${endpoint}/api/attachments`, {
          method: "POST",
          headers: authHeaders(config),
          body: form,
        });
      } catch (error) {
        throw networkError(endpoint, error);
      }
      if (!response.ok) {
        throw new CliError(
          `Upload of ${fileName} failed (HTTP ${response.status})`,
          response.status === 401 ? ExitCode.AuthError : ExitCode.GeneralError,
          transientCodeForStatus(response.status),
        );
      }
      return (await response.json()) as {
        readonly id: string;
        readonly fileName: string;
      };
    },
  };
}
