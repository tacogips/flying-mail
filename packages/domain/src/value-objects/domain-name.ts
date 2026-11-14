import { ValidationError } from "../errors";
import type { Brand } from "./ids";

/** A normalized, lower-cased fully-qualified domain name with at least two
 * labels (e.g. `example.com`). Always the result of {@link parseDomainName}
 * or {@link createDomainName}, never a bare cast. */
export type DomainName = Brand<string, "DomainName">;

const MAX_DOMAIN_LENGTH = 253;
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Parses and normalizes a domain name, returning `null` rather than
 * throwing. Use this on the inbound-mail path, where a malformed value in a
 * header is routine and must not abort processing the message. */
export function parseDomainName(value: string): DomainName | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_DOMAIN_LENGTH) {
    return null;
  }
  // A single trailing dot is the valid absolute-FQDN form; strip it before
  // splitting so `example.com.` does not produce an empty final label.
  const withoutRootDot = normalized.endsWith(".")
    ? normalized.slice(0, -1)
    : normalized;
  const labels = withoutRootDot.split(".");
  if (labels.length < 2) {
    return null;
  }
  for (const label of labels) {
    if (!LABEL_PATTERN.test(label)) {
      return null;
    }
  }
  return withoutRootDot as DomainName;
}

/** {@link parseDomainName}, but throws `ValidationError` on invalid input.
 * Use this on operator-facing paths (adding a managed domain), where a
 * malformed value is a mistake the caller should see. */
export function createDomainName(value: string, field = "domain"): DomainName {
  const parsed = parseDomainName(value);
  if (parsed === null) {
    throw new ValidationError(`${field} is not a valid domain name`, field);
  }
  return parsed;
}
