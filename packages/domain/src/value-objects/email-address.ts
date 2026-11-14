import { ValidationError } from "../errors";
import {
  createDomainName,
  type DomainName,
  parseDomainName,
} from "./domain-name";
import type { Brand } from "./ids";

/** A normalized, lower-cased `local@domain` mailbox. Deliberately does not
 * accept display-name (`Name <a@b.com>`) or address-list syntax: callers
 * that need those parse them first (the MIME adapter does) and hand the
 * bare mailbox here, so every stored address is directly comparable. */
export type EmailAddress = Brand<string, "EmailAddress">;

const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;
const LOCAL_PART_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const PRINTABLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;

function splitAddress(
  value: string,
): { readonly local: string; readonly domain: string } | null {
  const separatorIndex = value.lastIndexOf("@");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return null;
  }
  const local = value.slice(0, separatorIndex);
  const domain = value.slice(separatorIndex + 1);
  // A second `@` anywhere in the local part means this is not a plain
  // mailbox (quoted local parts are not supported -- see the type doc).
  if (local.includes("@")) {
    return null;
  }
  return { local, domain };
}

/** Parses and normalizes a mailbox, returning `null` rather than throwing.
 * Used on the inbound path where a malformed `Cc:` entry must be skipped,
 * not allowed to cost us the whole message. */
export function parseEmailAddress(value: string): EmailAddress | null {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_ADDRESS_LENGTH ||
    !PRINTABLE_ASCII_PATTERN.test(normalized)
  ) {
    return null;
  }
  const parts = splitAddress(normalized);
  if (parts === null) {
    return null;
  }
  const { local, domain } = parts;
  if (
    local.length > MAX_LOCAL_LENGTH ||
    !LOCAL_PART_PATTERN.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..")
  ) {
    return null;
  }
  if (parseDomainName(domain) === null) {
    return null;
  }
  return normalized as EmailAddress;
}

/** {@link parseEmailAddress}, but throws `ValidationError`. Used on
 * caller-facing paths (send inputs, user records) where a malformed address
 * is a mistake the caller should see. */
export function createEmailAddress(
  value: string,
  field = "email",
): EmailAddress {
  const parsed = parseEmailAddress(value);
  if (parsed === null) {
    throw new ValidationError(`${field} is not a valid email address`, field);
  }
  return parsed;
}

/** The part before the `@`. Already normalized, so no re-parsing is needed
 * by permission matching. */
export function emailLocalPart(address: EmailAddress): string {
  return address.slice(0, address.lastIndexOf("@"));
}

/** The part after the `@`, as a `DomainName`. */
export function emailDomainName(address: EmailAddress): DomainName {
  return createDomainName(address.slice(address.lastIndexOf("@") + 1));
}
