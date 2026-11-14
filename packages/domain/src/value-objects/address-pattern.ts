import { ValidationError } from "../errors";
import {
  type EmailAddress,
  emailDomainName,
  emailLocalPart,
  parseEmailAddress,
} from "./email-address";
import { parseDomainName } from "./domain-name";
import type { Brand } from "./ids";

/** The glob an API key scope is expressed in. Deliberately *not* a regex:
 * an operator-supplied regex matched against attacker-influenced addresses
 * is a denial-of-service footgun (catastrophic backtracking) and is hard to
 * audit when reviewing what a key can reach. This grammar covers every
 * realistic scope and matches in linear time.
 *
 * | Pattern                 | Matches                                |
 * |-------------------------|----------------------------------------|
 * | `*`                     | every address                          |
 * | `*@example.com`         | every mailbox on `example.com`         |
 * | `support@example.com`   | exactly that mailbox                   |
 * | `support-*@example.com` | local-part prefix match                 |
 * | `*-noreply@example.com` | local-part suffix match                 |
 */
export type AddressPattern = Brand<string, "AddressPattern">;

/** `*` -- the pattern every scope defaults to, matching any address. */
export const MATCH_ALL_ADDRESSES = "*" as AddressPattern;

const LOCAL_PATTERN_CHARS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;

/** Parses and normalizes a scope pattern, returning `null` on invalid
 * input. At most one `*` is permitted, and only in the local part (or as
 * the entire pattern). */
export function parseAddressPattern(value: string): AddressPattern | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized === "*") {
    return normalized as AddressPattern;
  }

  const separatorIndex = normalized.lastIndexOf("@");
  if (separatorIndex <= 0 || separatorIndex === normalized.length - 1) {
    return null;
  }
  const local = normalized.slice(0, separatorIndex);
  const domain = normalized.slice(separatorIndex + 1);

  // The domain part is always literal: a wildcard there would let one scope
  // straddle unrelated tenants, which is exactly what per-domain scoping
  // exists to prevent.
  if (parseDomainName(domain) === null) {
    return null;
  }
  if (local.includes("@") || !LOCAL_PATTERN_CHARS.test(local)) {
    return null;
  }
  const wildcardCount = local.split("*").length - 1;
  if (wildcardCount > 1) {
    return null;
  }
  // A literal local part must itself be a valid mailbox local part; reuse
  // the address parser rather than duplicating its rules.
  if (wildcardCount === 0 && parseEmailAddress(normalized) === null) {
    return null;
  }
  return normalized as AddressPattern;
}

/** {@link parseAddressPattern}, but throws `ValidationError`. */
export function createAddressPattern(
  value: string,
  field = "addressPattern",
): AddressPattern {
  const parsed = parseAddressPattern(value);
  if (parsed === null) {
    throw new ValidationError(`${field} is not a valid address pattern`, field);
  }
  return parsed;
}

function matchLocalPart(localPattern: string, local: string): boolean {
  const wildcardIndex = localPattern.indexOf("*");
  if (wildcardIndex === -1) {
    return localPattern === local;
  }
  const prefix = localPattern.slice(0, wildcardIndex);
  const suffix = localPattern.slice(wildcardIndex + 1);
  // Guard against prefix and suffix overlapping on a short local part, which
  // would otherwise let `ab-*-cd` style patterns match `ab-cd` twice over.
  if (local.length < prefix.length + suffix.length) {
    return false;
  }
  return local.startsWith(prefix) && local.endsWith(suffix);
}

/** True when `address` falls inside `pattern`. Both sides are already
 * normalized to lower case by their constructors, so this is a plain
 * comparison with no case folding. */
export function matchAddressPattern(
  pattern: AddressPattern,
  address: EmailAddress,
): boolean {
  if (pattern === MATCH_ALL_ADDRESSES) {
    return true;
  }
  const separatorIndex = pattern.lastIndexOf("@");
  const localPattern = pattern.slice(0, separatorIndex);
  const domainPattern = pattern.slice(separatorIndex + 1);
  if (emailDomainName(address) !== domainPattern) {
    return false;
  }
  return matchLocalPart(localPattern, emailLocalPart(address));
}

/** SQL-side companion to {@link matchAddressPattern}: renders the pattern as
 * a `LIKE` expression escaped for `ESCAPE '\'`. Kept here, beside the
 * grammar it mirrors, so the two can never drift apart. Returns `null` for
 * `*`, which needs no `LIKE` clause at all. */
export function addressPatternToLikeExpression(
  pattern: AddressPattern,
): string | null {
  if (pattern === MATCH_ALL_ADDRESSES) {
    return null;
  }
  const escaped = pattern
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  return escaped.replaceAll("*", "%");
}
