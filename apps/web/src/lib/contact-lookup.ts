import { CONTACTS_BY_EMAIL_QUERY } from "../api/contact-documents";
import type { ContactView } from "../api/contact-types";
import { graphqlRequest } from "../api/graphql-client";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  readonly expiresAt: number;
  readonly contacts: readonly ContactView[];
}

/** Per-session, in-memory only -- a reload naturally drops it, and a
 * contact edited elsewhere is stale for at most `CACHE_TTL_MS`. That is an
 * acceptable trade for not re-querying `contactsByEmail` on every
 * message-view paint. This is deliberately separate from
 * `contact-store.ts`'s state: the store drives the `/contacts` page, this
 * cache serves the "who is this sender?" hook from anywhere else. */
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<readonly ContactView[]>>();

function normalize(address: string): string {
  return address.trim().toLowerCase();
}

async function fetchContactsByEmail(
  address: string,
): Promise<readonly ContactView[]> {
  const result = await graphqlRequest<
    { readonly contactsByEmail: readonly ContactView[] },
    { email: string }
  >(CONTACTS_BY_EMAIL_QUERY, { email: address });
  return result.ok ? result.data.contactsByEmail : [];
}

/** Resolves every contact carrying `address`, across every readable
 * address book. Never rejects: a failed lookup resolves to an empty list so
 * a caller can render the no-match path without extra error handling. */
export async function lookupContactsByEmail(
  address: string,
): Promise<readonly ContactView[]> {
  const key = normalize(address);
  if (key.length === 0) {
    return [];
  }
  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.contacts;
  }
  const pending = inFlight.get(key);
  if (pending !== undefined) {
    return pending;
  }
  const request = fetchContactsByEmail(key).then((contacts) => {
    cache.set(key, { contacts, expiresAt: Date.now() + CACHE_TTL_MS });
    inFlight.delete(key);
    return contacts;
  });
  inFlight.set(key, request);
  return request;
}

/** The first match, for the common "who is this?" single-contact case a
 * message-view sender or recipient line asks. */
export async function lookupContactByEmail(
  address: string,
): Promise<ContactView | null> {
  const contacts = await lookupContactsByEmail(address);
  return contacts[0] ?? null;
}

/** Test-only: clears the module-level cache between test cases. */
export function clearContactLookupCache(): void {
  cache.clear();
  inFlight.clear();
}
