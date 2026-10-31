import { isIPv4 } from "node:net";
import { CliError, ExitCode } from "./exit-codes";

/** True for hostnames that can only be reached from this machine. Used both
 * to decide whether the `client serve` proxy may inject an API key and to
 * decide whether a plaintext endpoint is acceptable. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    (isIPv4(normalized) && normalized.startsWith("127."))
  );
}

/** Parses and validates a deployment endpoint.
 *
 * The API key travels as a bearer token on every request, so a plaintext
 * `http:` endpoint would expose it to anyone on the path. Only `https:` is
 * accepted, with `http:` allowed solely for loopback hosts (local
 * development against `wrangler dev`). The returned URL is not normalised
 * beyond parsing. */
export function parseEndpointUrl(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CliError(
      `Invalid endpoint URL "${endpoint}". Expected an absolute https:// URL.`,
      ExitCode.UsageError,
    );
  }
  if (url.protocol === "https:") {
    return url;
  }
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) {
    return url;
  }
  throw new CliError(
    url.protocol === "http:"
      ? `Refusing plaintext endpoint ${url.origin}: use https:// (http:// is only allowed for localhost), otherwise the API key is sent unencrypted.`
      : `Unsupported endpoint scheme "${url.protocol}". Use an https:// URL.`,
    ExitCode.UsageError,
  );
}
