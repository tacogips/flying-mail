import { createFakeRateLimiter } from "@flying-mail/application/test-support/auth-hardening-fakes";
import { createFakeDependencies } from "@flying-mail/application/test-support/fakes";
import { createUseCases } from "@flying-mail/application/usecases";
import {
  type RateLimiter,
  RateLimiterUnavailableError,
} from "@flying-mail/application/ports/rate-limiter";
import type { Viewer } from "@flying-mail/application/policies/viewer";
import { createAttachment } from "@flying-mail/domain/entities/attachment";
import {
  createInboundMessage,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import { UserRole } from "@flying-mail/domain/entities/user";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createApiKeyId,
  createAttachmentId,
  createDomainId,
  createMessageId,
  createThreadId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import type { AuthVariables } from "./auth-middleware";
import { createAttachmentRoutes } from "./attachments";

const NOW = "2026-08-23T00:00:00.000Z";
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

async function createHarness(
  options: {
    readonly fileName?: string;
    readonly contentType?: string;
    readonly rateLimiter?: RateLimiter;
    readonly viewer?: Viewer;
  } = {},
) {
  const fake = createFakeDependencies({
    now: NOW,
    ...(options.rateLimiter === undefined
      ? {}
      : { rateLimiter: options.rateLimiter }),
  });
  const usecases = createUseCases(fake.deps);
  const messageId = createMessageId("msg-1");
  const attachmentId = createAttachmentId("att-1");
  const blobKey = `att/${attachmentId}/${options.fileName ?? "report.pdf"}`;

  fake.messageStores.messages.set(
    messageId,
    createInboundMessage({
      id: messageId,
      domainId: createDomainId("dom-1"),
      threadId: createThreadId("thr-1"),
      rfcMessageId: "m1@other.com",
      inReplyTo: null,
      references: [],
      subject: "Hello",
      fromAddress: createEmailAddress("sender@other.com"),
      fromName: null,
      textBody: "body",
      htmlBody: null,
      rawKey: `raw/${messageId}.eml`,
      rawSize: 10,
      occurredAt: NOW,
      createdAt: NOW,
      spamScore: null,
    }),
  );
  fake.messageStores.recipients.set(messageId, [
    {
      kind: RecipientKind.Envelope,
      address: createEmailAddress("support@example.com"),
      name: null,
      position: 0,
    },
  ]);
  fake.messageStores.messageTags.set(messageId, new Set());
  fake.messageStores.attachments.set(
    attachmentId,
    createAttachment({
      id: attachmentId,
      messageId,
      fileName: options.fileName ?? "report.pdf",
      contentType: options.contentType ?? "application/pdf",
      size: 5,
      blobKey,
      contentId: null,
      inline: false,
      createdAt: NOW,
    }),
  );
  await fake.deps.blobs.put(blobKey, new TextEncoder().encode("hello"), {
    contentType: options.contentType ?? "application/pdf",
  });

  const viewer: Viewer = options.viewer ?? {
    kind: "USER",
    userId: createUserId("usr-1"),
    role: UserRole.Admin,
    permissions: [],
    templatePermissions: [],
  };
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createAttachmentRoutes(fake.deps, usecases));

  return { app, attachmentId };
}

describe("attachment routes", () => {
  test("returns a structured 413 when the multipart file exceeds the limit", async () => {
    const { app } = await createHarness();
    const formData = new FormData();
    formData.append(
      "file",
      new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "large.bin"),
    );

    const response = await app.request("/attachments", {
      method: "POST",
      body: formData,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Attachment exceeds the 5 MB size limit",
      code: "PAYLOAD_TOO_LARGE",
      maxBytes: MAX_ATTACHMENT_BYTES,
    });
  });

  test("returns the same structured 413 from the Content-Length precheck", async () => {
    const { app } = await createHarness();
    const response = await app.request(
      new Request("http://localhost/attachments", {
        method: "POST",
        headers: {
          "content-length": String(MAX_ATTACHMENT_BYTES + 64 * 1024 + 1),
        },
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Attachment exceeds the 5 MB size limit",
      code: "PAYLOAD_TOO_LARGE",
      maxBytes: MAX_ATTACHMENT_BYTES,
    });
  });

  test("downloads a readable attachment with RFC 5987 and safe headers", async () => {
    const { app, attachmentId } = await createHarness({
      fileName: "報告書 2026.pdf",
    });
    const response = await app.request(`/attachments/${attachmentId}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      'filename="___ 2026.pdf"',
    );
    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''%E5%A0%B1%E5%91%8A%E6%9B%B8%202026.pdf",
    );
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("forces non-allowlisted content types to download", async () => {
    const { app, attachmentId } = await createHarness({
      fileName: "message.html",
      contentType: "text/html",
    });
    const response = await app.request(`/attachments/${attachmentId}`);

    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  describe("upload rate limit", () => {
    function smallUpload(): FormData {
      const formData = new FormData();
      formData.append("file", new File([new Uint8Array(4)], "note.txt"));
      return formData;
    }

    test("keys the limiter by user principal before doing any work", async () => {
      const { limiter, keys } = createFakeRateLimiter();
      const { app } = await createHarness({ rateLimiter: limiter });
      const response = await app.request("/attachments", {
        method: "POST",
        body: smallUpload(),
      });
      expect(keys).toEqual(["upload:user:usr-1"]);
      expect(response.status).not.toBe(429);
    });

    test("keys the limiter by api key principal", async () => {
      const { limiter, keys } = createFakeRateLimiter();
      const { app } = await createHarness({
        rateLimiter: limiter,
        viewer: {
          kind: "API_KEY",
          apiKeyId: createApiKeyId("key-1"),
          scopes: [],
        },
      });
      await app.request("/attachments", {
        method: "POST",
        body: smallUpload(),
      });
      expect(keys).toEqual(["upload:key:key-1"]);
    });

    test("fails open and still uploads when the limiter is unavailable", async () => {
      const { app } = await createHarness({
        rateLimiter: {
          async limit(): Promise<boolean> {
            throw new RateLimiterUnavailableError("binding down");
          },
        },
      });
      const response = await app.request("/attachments", {
        method: "POST",
        body: smallUpload(),
      });
      expect(response.status).toBe(201);
    });

    test("returns 429 and skips the upload when limited", async () => {
      const { limiter } = createFakeRateLimiter({
        deny: new Set(["upload:user:usr-1"]),
      });
      const { app } = await createHarness({ rateLimiter: limiter });
      const response = await app.request("/attachments", {
        method: "POST",
        body: smallUpload(),
      });
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: "Too many requests" });
    });

    test("limits before the Content-Length size precheck", async () => {
      const { limiter } = createFakeRateLimiter({
        deny: new Set(["upload:user:usr-1"]),
      });
      const { app } = await createHarness({ rateLimiter: limiter });
      const response = await app.request(
        new Request("http://localhost/attachments", {
          method: "POST",
          headers: {
            "content-length": String(MAX_ATTACHMENT_BYTES + 64 * 1024 + 1),
          },
        }),
      );
      // The limiter runs first, so a limited principal never reaches the
      // size check.
      expect(response.status).toBe(429);
    });
  });
});
