import type {
  BuildMimeInput,
  MimeBuilder,
} from "@flying-mail/application/ports/mime";
import { createMimeMessage, Mailbox, type MIMEMessage } from "mimetext/browser";
import {
  assertThreadingHeadersSafe,
  FORBIDDEN_HEADER_VALUE,
  HeaderInjectionError,
} from "./header-safety";

export { HeaderInjectionError };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** mimetext's recipient setters take a homogeneous array, so a mixed list
 * of bare addresses and named mailboxes is normalized to the object form. */
function toMailboxObjects(
  entries: readonly {
    readonly address: string;
    readonly name: string | null;
  }[],
): { addr: string; name: string }[] {
  return entries.map((entry) => ({
    addr: entry.address,
    name: entry.name ?? "",
  }));
}

function applyRecipients(message: MIMEMessage, input: BuildMimeInput): void {
  message.setTo(toMailboxObjects(input.to));
  if (input.cc !== undefined && input.cc.length > 0) {
    message.setCc(toMailboxObjects(input.cc));
  }
}

function applyBodies(message: MIMEMessage, input: BuildMimeInput): void {
  if (input.text !== undefined && input.text.length > 0) {
    message.addMessage({ contentType: "text/plain", data: input.text });
  }
  if (input.html !== undefined && input.html.length > 0) {
    message.addMessage({ contentType: "text/html", data: input.html });
  }
}

function applyThreadingHeaders(
  message: MIMEMessage,
  input: BuildMimeInput,
): void {
  assertThreadingHeadersSafe(input);
  message.setHeader("Message-ID", `<${input.messageId}>`);
  message.setHeader("Date", new Date(input.date).toUTCString());
  if (input.replyTo !== undefined) {
    if (
      FORBIDDEN_HEADER_VALUE.test(input.replyTo.address) ||
      (input.replyTo.name !== null &&
        FORBIDDEN_HEADER_VALUE.test(input.replyTo.name))
    ) {
      throw new HeaderInjectionError("Reply-To");
    }
    const mailbox =
      input.replyTo.name === null
        ? input.replyTo.address
        : { addr: input.replyTo.address, name: input.replyTo.name };
    message.setHeader("Reply-To", new Mailbox(mailbox));
  }
  if (input.inReplyTo !== undefined) {
    message.setHeader("In-Reply-To", `<${input.inReplyTo}>`);
  }
  if (input.references !== undefined && input.references.length > 0) {
    message.setHeader(
      "References",
      input.references.map((reference) => `<${reference}>`).join(" "),
    );
  }
}

function applyCustomHeaders(message: MIMEMessage, input: BuildMimeInput): void {
  for (const [name, value] of input.headers ?? new Map<string, string>()) {
    if (
      FORBIDDEN_HEADER_VALUE.test(value) ||
      FORBIDDEN_HEADER_VALUE.test(name)
    ) {
      throw new HeaderInjectionError(name);
    }
    message.setHeader(name, value);
  }
}

function applyAttachments(message: MIMEMessage, input: BuildMimeInput): void {
  for (const attachment of input.attachments ?? []) {
    // Backstop: the domain validates content types, but a part header is
    // built from this value directly.
    if (FORBIDDEN_HEADER_VALUE.test(attachment.contentType)) {
      throw new HeaderInjectionError("Content-Type");
    }
    if (
      attachment.contentId !== null &&
      FORBIDDEN_HEADER_VALUE.test(attachment.contentId)
    ) {
      throw new HeaderInjectionError("Content-ID");
    }
    message.addAttachment({
      filename: attachment.fileName,
      contentType: attachment.contentType,
      data: toBase64(attachment.content),
      ...(attachment.inline && attachment.contentId !== null
        ? {
            inline: true,
            headers: { "Content-ID": `<${attachment.contentId}>` },
          }
        : {}),
    });
  }
}

/** Maps `mimetext` onto the `MimeBuilder` port.
 *
 * The browser entrypoint is used deliberately: it relies on `btoa` rather
 * than Node's `Buffer`, so the same build runs on Workers, Bun and Node. */
export function createMimeTextBuilder(): MimeBuilder {
  return {
    build(input: BuildMimeInput): string {
      const message = createMimeMessage();
      message.setSender(
        input.from.name === null
          ? input.from.address
          : { addr: input.from.address, name: input.from.name },
      );
      applyRecipients(message, input);
      message.setSubject(input.subject);
      applyBodies(message, input);
      applyThreadingHeaders(message, input);
      applyCustomHeaders(message, input);
      applyAttachments(message, input);
      return message.asRaw();
    },
  };
}
