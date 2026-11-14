/** Largest raw RFC 5322 message the external-mail fetch clients (JMAP,
 * POP3) will pull into memory, in bytes.
 *
 * Matches `MAX_INBOUND_RAW_BYTES` in the application layer's ingest use
 * case, which refuses anything larger anyway. It is repeated here, rather
 * than imported, because the adapter layer must not depend on application
 * use cases, and because the clients need to enforce it *while reading*:
 * ingest only sees the message after it has been fully buffered. */
export const MAX_FETCHED_RAW_BYTES = 25 * 1024 * 1024;
