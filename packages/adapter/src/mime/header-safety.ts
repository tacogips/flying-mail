/** Header-injection guards shared by everything in the adapter that writes a
 * value into an outbound header: the MIME builder and the provider-API mail
 * senders. */

/** Thrown when a caller-supplied header value contains CR or LF.
 *
 * This is the last line of the header-injection defence: the send use case
 * validates headers too, but enforcing it here means *any* path that builds
 * a MIME source is covered, including a future one that forgets to. */
export class HeaderInjectionError extends Error {
  constructor(readonly headerName: string) {
    super(`Header "${headerName}" must not contain CR or LF`);
    this.name = "HeaderInjectionError";
  }
}

export const FORBIDDEN_HEADER_VALUE = /[\r\n]/;

/** Throws {@link HeaderInjectionError} when `value` contains CR or LF. */
export function assertHeaderValueSafe(headerName: string, value: string): void {
  if (FORBIDDEN_HEADER_VALUE.test(value)) {
    throw new HeaderInjectionError(headerName);
  }
}

/** Validates a message id (without angle brackets) destined for a
 * `Message-ID`, `In-Reply-To` or `References` header. Ids come from inbound
 * mail, which is attacker-controlled, so CR/LF is refused here even though
 * the parser already drops such ids at ingest. */
export function assertMessageIdSafe(headerName: string, id: string): void {
  assertHeaderValueSafe(headerName, id);
}

/** Validates the threading headers of an outbound message. */
export function assertThreadingHeadersSafe(input: {
  readonly messageId?: string | undefined;
  readonly inReplyTo?: string | undefined;
  readonly references?: readonly string[] | undefined;
}): void {
  if (input.messageId !== undefined) {
    assertMessageIdSafe("Message-ID", input.messageId);
  }
  if (input.inReplyTo !== undefined) {
    assertMessageIdSafe("In-Reply-To", input.inReplyTo);
  }
  for (const reference of input.references ?? []) {
    assertMessageIdSafe("References", reference);
  }
}
