import { RateLimiterUnavailableError } from "@flying-mail/application/ports/rate-limiter";
import { Capability } from "@flying-mail/domain/entities/api-key";
import { createFakeRateLimiter } from "@flying-mail/application/test-support/auth-hardening-fakes";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "@flying-mail/application/test-support/fakes";
import {
  createUseCases,
  type UseCases,
} from "@flying-mail/application/usecases";
import { createAttachment } from "@flying-mail/domain/entities/attachment";
import {
  createMailDomain,
  verifyMailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import {
  createInboundMessage,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import { createSession } from "@flying-mail/domain/entities/session";
import { createUser, UserRole } from "@flying-mail/domain/entities/user";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createAttachmentId,
  createDomainId,
  createMessageId,
  createSessionId,
  createThreadId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./app";
import {
  type AuthVariables,
  buildClearSessionCookieHeader,
  buildSetSessionCookieHeader,
  extractBearerToken,
  extractSessionCookie,
  isCrossOriginRequest,
  isPlainHttpLocalhost,
  resetAuthSweepLatchForTesting,
  SESSION_COOKIE_NAME,
} from "./auth-middleware";
import { encodeContentDisposition, isInlineSafeContentType } from "./downloads";

const NOW = "2026-08-23T00:00:00.000Z";
const ORIGIN = "https://mail.example.com";
const domainId = createDomainId("dom-1");
const messageId = createMessageId("msg-1");
const attachmentId = createAttachmentId("att-1");

interface Harness {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly fake: FakeDependencies;
  readonly usecases: UseCases;
  readonly sessionToken: string;
  readonly apiKeySecret: string;
}

async function createHarness(): Promise<Harness> {
  const fake = createFakeDependencies({ now: NOW });
  const usecases = createUseCases(fake.deps);

  await fake.deps.mailDomainRepository.save(
    verifyMailDomain(
      createMailDomain({
        id: domainId,
        name: createDomainName("example.com"),
        catchAll: true,
        verificationToken: "tok",
        createdAt: NOW,
      }),
      NOW,
    ),
  );

  const user = createUser({
    id: createUserId("usr-1"),
    email: createEmailAddress("me@example.com"),
    name: "Taro",
    role: UserRole.Admin,
    createdAt: NOW,
  });
  fake.stores.users.set(user.id, user);

  const sessionToken = "session-token";
  fake.stores.sessions.set(
    "ses-1",
    createSession({
      id: createSessionId("ses-1"),
      tokenHash: `hash(${sessionToken})`,
      userId: user.id,
      expiresAt: "2026-09-23T00:00:00.000Z",
      createdAt: NOW,
    }),
  );

  const issued = await usecases.createApiKey(
    {
      kind: "USER",
      userId: user.id,
      role: UserRole.Admin,
      permissions: [],
      templatePermissions: [],
    },
    {
      name: "agent",
      scopes: [
        { capability: Capability.MailRead, domainId, addressPattern: "*" },
        { capability: Capability.FileLink, domainId, addressPattern: "*" },
        { capability: Capability.MailSend, domainId, addressPattern: "*" },
      ],
      expiresAt: null,
    },
  );

  // Seed one readable message with an attachment.
  fake.messageStores.messages.set(
    messageId,
    createInboundMessage({
      id: messageId,
      domainId,
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
      fileName: "report.pdf",
      contentType: "application/pdf",
      size: 5,
      blobKey: `att/${attachmentId}/report.pdf`,
      contentId: null,
      inline: false,
      createdAt: NOW,
    }),
  );
  await fake.deps.blobs.put(
    `att/${attachmentId}/report.pdf`,
    new TextEncoder().encode("hello"),
    { contentType: "application/pdf" },
  );

  resetAuthSweepLatchForTesting();

  return {
    app: createApp({ deps: fake.deps, usecases, graphiql: false }),
    fake,
    usecases,
    sessionToken,
    apiKeySecret: issued.secret,
  };
}

function graphqlRequest(
  query: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ query }),
  });
}

describe("auth middleware helpers", () => {
  test("extracts a bearer token", () => {
    expect(
      extractBearerToken(
        new Request(ORIGIN, { headers: { authorization: "Bearer abc" } }),
      ),
    ).toBe("abc");
  });

  test.each([
    ["no header", {}],
    ["a non-bearer scheme", { authorization: "Basic abc" }],
    ["an empty token", { authorization: "Bearer   " }],
  ])("returns null for %s", (_label, headers) => {
    expect(extractBearerToken(new Request(ORIGIN, { headers }))).toBeNull();
  });

  test("extracts the session cookie among others", () => {
    expect(
      extractSessionCookie(
        new Request(ORIGIN, {
          headers: { cookie: `other=1; ${SESSION_COOKIE_NAME}=abc%2Fdef; x=2` },
        }),
      ),
    ).toBe("abc/def");
  });

  test.each([
    ["no cookie header", {}],
    ["a different cookie", { cookie: "other=1" }],
    ["an empty value", { cookie: `${SESSION_COOKIE_NAME}=` }],
  ])("returns null for %s", (_label, headers) => {
    expect(extractSessionCookie(new Request(ORIGIN, { headers }))).toBeNull();
  });

  test("only plain-http loopback omits Secure", () => {
    expect(isPlainHttpLocalhost(new Request("http://localhost:8787/x"))).toBe(
      true,
    );
    expect(isPlainHttpLocalhost(new Request("http://127.0.0.1:8787/x"))).toBe(
      true,
    );
    expect(isPlainHttpLocalhost(new Request("https://localhost/x"))).toBe(
      false,
    );
    expect(isPlainHttpLocalhost(new Request("http://mail.example.com/x"))).toBe(
      false,
    );
  });

  test("cookie rendering reflects the Secure option", () => {
    const secure = buildSetSessionCookieHeader(
      "tok",
      new Date("2026-09-23T00:00:00.000Z"),
      { secure: true },
    );
    expect(secure).toContain("HttpOnly");
    expect(secure).toContain("SameSite=Lax");
    expect(secure).toContain("Secure");

    const insecure = buildSetSessionCookieHeader(
      "tok",
      new Date("2026-09-23T00:00:00.000Z"),
      { secure: false },
    );
    expect(insecure).not.toContain("Secure");

    expect(buildClearSessionCookieHeader({ secure: true })).toContain(
      "Max-Age=0",
    );
  });

  test("cross-origin detection", () => {
    const withOrigin = (origin: string) =>
      new Request(`${ORIGIN}/graphql`, {
        method: "POST",
        headers: { origin },
      });
    expect(isCrossOriginRequest(withOrigin(ORIGIN), ORIGIN)).toBe(false);
    expect(isCrossOriginRequest(withOrigin("https://evil.com"), ORIGIN)).toBe(
      true,
    );
    // A malformed Origin fails closed.
    expect(isCrossOriginRequest(withOrigin("not a url"), ORIGIN)).toBe(true);
    // An absent Origin is treated as safe: browsers always send it on POST.
    expect(
      isCrossOriginRequest(
        new Request(`${ORIGIN}/graphql`, { method: "POST" }),
        ORIGIN,
      ),
    ).toBe(false);
  });
});

describe("download helpers", () => {
  test.each([
    ["image/png", true],
    ["text/plain; charset=utf-8", true],
    ["application/pdf", true],
    ["text/html", false],
    ["image/svg+xml", false],
    ["application/xhtml+xml", false],
    ["application/octet-stream", false],
  ])("%s inline-safe: %s", (contentType, expected) => {
    expect(isInlineSafeContentType(contentType)).toBe(expected);
  });

  test("encodes a non-ascii filename with RFC 5987", () => {
    const header = encodeContentDisposition("attachment", "請求書.pdf");
    expect(header).toContain(`filename*=UTF-8''`);
    expect(header).toContain(encodeURIComponent("請求書.pdf"));
    // The ASCII fallback must not contain raw non-ascii bytes.
    expect(header).toMatch(/filename="_+\.pdf"/);
  });

  test("strips quotes so a filename cannot inject header directives", () => {
    const header = encodeContentDisposition(
      "attachment",
      'evil";Set-Cookie: a=b',
    );
    expect(header).not.toContain('evil";');
  });
});

describe("app", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  test("resolves a session cookie to a viewer", async () => {
    const response = await harness.app.request(
      graphqlRequest("{ viewer { user { email } } }", {
        cookie: `${SESSION_COOKIE_NAME}=${harness.sessionToken}`,
        origin: ORIGIN,
      }),
    );
    const body = (await response.json()) as {
      data: { viewer: { user: { email: string } } };
    };
    expect(body.data.viewer.user.email).toBe("me@example.com");
  });

  test("resolves a bearer api key to a viewer", async () => {
    const response = await harness.app.request(
      graphqlRequest("{ viewer { capabilities } }", {
        authorization: `Bearer ${harness.apiKeySecret}`,
      }),
    );
    const body = (await response.json()) as {
      data: { viewer: { capabilities: string[] } };
    };
    expect(body.data.viewer.capabilities).toContain("MAIL_READ");
  });

  test("an unauthenticated request still reaches the resolver", async () => {
    const response = await harness.app.request(
      graphqlRequest("{ viewer { capabilities } }"),
    );
    const body = (await response.json()) as { data: { viewer: null } };
    expect(response.status).toBe(200);
    expect(body.data.viewer).toBeNull();
  });

  test("rejects a cross-origin cookie POST", async () => {
    const response = await harness.app.request(
      graphqlRequest("{ viewer { capabilities } }", {
        cookie: `${SESSION_COOKIE_NAME}=${harness.sessionToken}`,
        origin: "https://evil.com",
      }),
    );
    expect(response.status).toBe(403);
  });

  test("a cross-origin bearer POST is allowed", async () => {
    const response = await harness.app.request(
      graphqlRequest("{ viewer { capabilities } }", {
        authorization: `Bearer ${harness.apiKeySecret}`,
        origin: "https://evil.com",
      }),
    );
    expect(response.status).toBe(200);
  });

  describe("cross-origin reads", () => {
    const cookie = () => `${SESSION_COOKIE_NAME}=${harness.sessionToken}`;
    const graphqlGet = (headers: Record<string, string>) =>
      new Request(
        `${ORIGIN}/graphql?query=${encodeURIComponent("{ viewer { capabilities } }")}`,
        { headers },
      );

    test("rejects a cookie-authenticated GET carrying a foreign Origin", async () => {
      const graphql = await harness.app.request(
        graphqlGet({ cookie: cookie(), origin: "https://evil.com" }),
      );
      expect(graphql.status).toBe(403);

      const attachment = await harness.app.request(
        new Request(`${ORIGIN}/api/attachments/${attachmentId}`, {
          headers: { cookie: cookie(), origin: "https://evil.com" },
        }),
      );
      expect(attachment.status).toBe(403);

      const head = await harness.app.request(
        new Request(`${ORIGIN}/api/attachments/${attachmentId}`, {
          method: "HEAD",
          headers: { cookie: cookie(), origin: "https://evil.com" },
        }),
      );
      expect(head.status).toBe(403);
    });

    test("allows a cookie GET with a same-origin Origin", async () => {
      const response = await harness.app.request(
        graphqlGet({ cookie: cookie(), origin: ORIGIN }),
      );
      expect(response.status).toBe(200);
    });

    test("allows a cookie GET with no Origin, like a top-level navigation", async () => {
      const response = await harness.app.request(
        new Request(`${ORIGIN}/api/attachments/${attachmentId}`, {
          headers: { cookie: cookie() },
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("hello");
    });

    test("a bearer GET with a foreign Origin is still allowed", async () => {
      const response = await harness.app.request(
        graphqlGet({
          authorization: `Bearer ${harness.apiKeySecret}`,
          origin: "https://evil.com",
        }),
      );
      expect(response.status).toBe(200);
    });

    test("emits no CORS headers, even for a foreign Origin", async () => {
      const simple = await harness.app.request(
        graphqlRequest("{ viewer { capabilities } }", {
          authorization: `Bearer ${harness.apiKeySecret}`,
          origin: "https://evil.com",
        }),
      );
      expect(simple.headers.get("access-control-allow-origin")).toBeNull();
      expect(simple.headers.get("access-control-allow-credentials")).toBeNull();

      const preflight = await harness.app.request(
        new Request(`${ORIGIN}/graphql`, {
          method: "OPTIONS",
          headers: {
            origin: "https://evil.com",
            "access-control-request-method": "POST",
          },
        }),
      );
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
      expect(
        preflight.headers.get("access-control-allow-credentials"),
      ).toBeNull();
    });
  });

  describe("graphql body limit", () => {
    const OVERSIZE = 1_048_576 + 1;

    function streamOf(totalBytes: number, chunkBytes = 64 * 1024) {
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= totalBytes) {
            controller.close();
            return;
          }
          const size = Math.min(chunkBytes, totalBytes - sent);
          // Spaces are insignificant JSON whitespace, so the padded body
          // below remains a valid document.
          controller.enqueue(new Uint8Array(size).fill(0x20));
          sent += size;
        },
      });
    }

    function streamedPost(prefix: string, padBytes: number, suffix: string) {
      const encoder = new TextEncoder();
      const padding = streamOf(padBytes);
      const reader = padding.getReader();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(prefix));
        },
        async pull(controller) {
          const next = await reader.read();
          if (next.done) {
            controller.enqueue(encoder.encode(suffix));
            controller.close();
            return;
          }
          controller.enqueue(next.value);
        },
      });
      return new Request(`${ORIGIN}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit);
    }

    test("rejects a declared Content-Length over the cap with 413", async () => {
      const response = await harness.app.request(
        graphqlRequest("{ viewer { capabilities } }", {
          "content-length": String(OVERSIZE),
        }),
      );
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: "Request body too large",
      });
    });

    test("accepts a declared Content-Length at the cap", async () => {
      const response = await harness.app.request(
        graphqlRequest("{ viewer { capabilities } }", {
          "content-length": "1048576",
        }),
      );
      expect(response.status).toBe(200);
    });

    test("aborts a streamed body with no Content-Length once over the cap", async () => {
      const response = await harness.app.request(
        streamedPost('{"query":"{ viewer { capabilities } }"}', OVERSIZE, ""),
      );
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: "Request body too large",
      });
    });

    test("still serves a streamed body under the cap", async () => {
      const response = await harness.app.request(
        streamedPost('{"query":"{ viewer { capabilities } }"', 200_000, "}"),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: { viewer: unknown } };
      expect(body.data.viewer).toBeNull();
    });

    test("does not apply to GET requests", async () => {
      const response = await harness.app.request(
        new Request(
          `${ORIGIN}/graphql?query=${encodeURIComponent("{ viewer { capabilities } }")}`,
          { headers: { "content-length": String(OVERSIZE) } },
        ),
      );
      expect(response.status).toBe(200);
    });
  });

  test("GraphQL responses are never cached", async () => {
    const response = await harness.app.request(
      graphqlRequest("{ viewer { capabilities } }"),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("baseline security headers are applied", async () => {
    const response = await harness.app.request(
      graphqlRequest("{ viewer { capabilities } }"),
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  test("an unmatched /api path is a JSON 404, never the SPA", async () => {
    const response = await harness.app.request(
      new Request(`${ORIGIN}/api/nope`),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("the SPA fallthrough handles everything else", async () => {
    const app = createApp({
      deps: harness.fake.deps,
      usecases: harness.usecases,
      graphiql: false,
      onNotFound: async () =>
        new Response("<html>spa</html>", {
          headers: { "content-type": "text/html" },
        }),
    });
    const response = await app.request(new Request(`${ORIGIN}/mailbox`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("spa");
    // HTML responses get the CSP, which permits the sandboxed mail iframe.
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-src 'self'",
    );
  });

  describe("attachment routes", () => {
    test("download requires authentication", async () => {
      const response = await harness.app.request(
        new Request(`${ORIGIN}/api/attachments/${attachmentId}`),
      );
      expect(response.status).toBe(401);
    });

    test("downloads with a hardened response", async () => {
      const response = await harness.app.request(
        new Request(`${ORIGIN}/api/attachments/${attachmentId}`, {
          headers: { authorization: `Bearer ${harness.apiKeySecret}` },
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("hello");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe("sandbox");
      expect(response.headers.get("content-disposition")).toContain("inline");
    });

    test("hides a message attachment from a key outside the mailbox scope", async () => {
      const denied = await harness.usecases.createApiKey(
        {
          kind: "USER",
          userId: createUserId("usr-1"),
          role: UserRole.Admin,
          permissions: [],
          templatePermissions: [],
        },
        {
          name: "other-mailbox",
          scopes: [
            {
              capability: Capability.MailRead,
              domainId,
              addressPattern: "billing@example.com",
            },
          ],
          expiresAt: null,
        },
      );

      const response = await harness.app.request(
        new Request(`${ORIGIN}/api/attachments/${attachmentId}`, {
          headers: { authorization: `Bearer ${denied.secret}` },
        }),
      );
      expect(response.status).toBe(404);
    });

    test("?download=1 forces an attachment disposition", async () => {
      const response = await harness.app.request(
        new Request(`${ORIGIN}/api/attachments/${attachmentId}?download=1`, {
          headers: { authorization: `Bearer ${harness.apiKeySecret}` },
        }),
      );
      expect(response.headers.get("content-disposition")).toContain(
        "attachment",
      );
    });

    test("an unknown attachment is a 404", async () => {
      const response = await harness.app.request(
        new Request(`${ORIGIN}/api/attachments/nope`, {
          headers: { authorization: `Bearer ${harness.apiKeySecret}` },
        }),
      );
      expect(response.status).toBe(404);
    });

    test("uploads a staged attachment", async () => {
      const form = new FormData();
      form.set(
        "file",
        new File([new TextEncoder().encode("data")], "notes.txt", {
          type: "text/plain",
        }),
      );
      const response = await harness.app.request(
        new Request(`${ORIGIN}/api/attachments`, {
          method: "POST",
          headers: { authorization: `Bearer ${harness.apiKeySecret}` },
          body: form,
        }),
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        id: string;
        fileName: string;
        url: string;
      };
      expect(body.fileName).toBe("notes.txt");
      expect(body.url).toBe(`/api/attachments/${body.id}`);
    });

    test("an upload from a key without MAIL_SEND is a 403", async () => {
      const readOnly = await harness.usecases.createApiKey(
        {
          kind: "USER",
          userId: createUserId("usr-1"),
          role: UserRole.Admin,
          permissions: [],
          templatePermissions: [],
        },
        {
          name: "read-only",
          scopes: [
            { capability: Capability.MailRead, domainId, addressPattern: "*" },
          ],
          expiresAt: null,
        },
      );
      const form = new FormData();
      form.set("file", new File(["data"], "notes.txt", { type: "text/plain" }));
      const response = await harness.app.request(
        new Request(`${ORIGIN}/api/attachments`, {
          method: "POST",
          headers: { authorization: `Bearer ${readOnly.secret}` },
          body: form,
        }),
      );
      expect(response.status).toBe(403);
    });

    test("a staged upload is not downloadable until it is sent", async () => {
      const form = new FormData();
      form.set("file", new File(["data"], "notes.txt", { type: "text/plain" }));
      const uploaded = (await (
        await harness.app.request(
          new Request(`${ORIGIN}/api/attachments`, {
            method: "POST",
            headers: { authorization: `Bearer ${harness.apiKeySecret}` },
            body: form,
          }),
        )
      ).json()) as { id: string };

      // It belongs to no message, so there is nothing to authorize against
      // -- serving it would expose one caller's pending upload to another.
      const response = await harness.app.request(
        new Request(`${ORIGIN}/api/attachments/${uploaded.id}`, {
          headers: { authorization: `Bearer ${harness.apiKeySecret}` },
        }),
      );
      expect(response.status).toBe(404);
    });

    test("upload requires authentication", async () => {
      const form = new FormData();
      form.set("file", new File(["data"], "notes.txt"));
      const response = await harness.app.request(
        new Request(`${ORIGIN}/api/attachments`, {
          method: "POST",
          body: form,
        }),
      );
      expect(response.status).toBe(401);
    });

    test("a missing file field is a 400", async () => {
      const response = await harness.app.request(
        new Request(`${ORIGIN}/api/attachments`, {
          method: "POST",
          headers: { authorization: `Bearer ${harness.apiKeySecret}` },
          body: new FormData(),
        }),
      );
      expect(response.status).toBe(400);
    });

    test("an oversized Content-Length is rejected unread", async () => {
      const response = await harness.app.request(
        new Request(`${ORIGIN}/api/attachments`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${harness.apiKeySecret}`,
            "content-type": "multipart/form-data; boundary=x",
            "content-length": String(50 * 1024 * 1024),
          },
          body: "ignored",
        }),
      );
      expect(response.status).toBe(413);
    });
  });

  describe("file link route", () => {
    async function mintLink(): Promise<string> {
      const created = await harness.usecases.createAttachmentLink(
        {
          kind: "USER",
          userId: createUserId("usr-1"),
          role: UserRole.Admin,
          permissions: [],
          templatePermissions: [],
        },
        attachmentId,
        900,
        2,
      );
      return created.token;
    }

    test("serves the file with no credential at all", async () => {
      const token = await mintLink();
      const response = await harness.app.request(
        new Request(`${ORIGIN}/files/${token}`),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("hello");
      expect(response.headers.get("content-security-policy")).toBe("sandbox");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    });

    test.each([
      ["an unknown token", "nope"],
      ["a token-shaped value", "abcdefghijklmnop"],
    ])("returns an identical 404 for %s", async (_label, token) => {
      const response = await harness.app.request(
        new Request(`${ORIGIN}/files/${token}`),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
    });

    test("returns the same 404 once exhausted", async () => {
      const token = await mintLink();
      await harness.app.request(new Request(`${ORIGIN}/files/${token}`));
      await harness.app.request(new Request(`${ORIGIN}/files/${token}`));
      const third = await harness.app.request(
        new Request(`${ORIGIN}/files/${token}`),
      );
      expect(third.status).toBe(404);
      expect(await third.json()).toEqual({ error: "Not found" });
    });

    test("returns the same 404 once expired", async () => {
      const token = await mintLink();
      harness.fake.clock.advanceSeconds(1000);
      const response = await harness.app.request(
        new Request(`${ORIGIN}/files/${token}`),
      );
      expect(response.status).toBe(404);
    });

    describe("hardening", () => {
      const CLIENT_IP = "203.0.113.9";
      const UNKNOWN_TOKEN = "A".repeat(43);

      function appWithLimiter(deny: ReadonlySet<string> = new Set()) {
        const { limiter, keys } = createFakeRateLimiter({ deny });
        const app = createApp({
          deps: { ...harness.fake.deps, rateLimiter: limiter },
          usecases: harness.usecases,
          graphiql: false,
          resolveClientIp: () => CLIENT_IP,
        });
        return { app, keys };
      }

      test.each([
        ["too short", "A".repeat(42)],
        ["too long", "A".repeat(44)],
        ["bad alphabet", `${"A".repeat(42)}!`],
        ["padded base64", `${"A".repeat(42)}=`],
      ])(
        "rejects a %s token with the uniform 404 and no limiter call",
        async (_label, token) => {
          const { app, keys } = appWithLimiter();
          const response = await app.request(
            new Request(`${ORIGIN}/files/${encodeURIComponent(token)}`),
          );
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({ error: "Not found" });
          expect(keys).toEqual([]);
        },
      );

      test("a well-formed unknown token is a 404 and is rate-limited by IP", async () => {
        const { app, keys } = appWithLimiter();
        const response = await app.request(
          new Request(`${ORIGIN}/files/${UNKNOWN_TOKEN}`),
        );
        expect(response.status).toBe(404);
        expect(keys).toEqual([`files:${CLIENT_IP}`]);
      });

      test("fails open when the limiter is unavailable", async () => {
        const token = await mintLink();
        const app = createApp({
          deps: {
            ...harness.fake.deps,
            rateLimiter: {
              async limit(): Promise<boolean> {
                throw new RateLimiterUnavailableError("binding down");
              },
            },
          },
          usecases: harness.usecases,
          graphiql: false,
          resolveClientIp: () => CLIENT_IP,
        });
        const response = await app.request(
          new Request(`${ORIGIN}/files/${token}`),
        );
        expect(response.status).toBe(200);
      });

      test("returns 429 when the limiter denies the client", async () => {
        const token = await mintLink();
        const { app } = appWithLimiter(new Set([`files:${CLIENT_IP}`]));
        const response = await app.request(
          new Request(`${ORIGIN}/files/${token}`),
        );
        expect(response.status).toBe(429);
        expect(await response.json()).toEqual({ error: "Too many requests" });
      });

      test("does not limit when no client IP can be resolved", async () => {
        const { limiter, keys } = createFakeRateLimiter({
          deny: new Set([`files:${CLIENT_IP}`]),
        });
        const app = createApp({
          deps: { ...harness.fake.deps, rateLimiter: limiter },
          usecases: harness.usecases,
          graphiql: false,
          resolveClientIp: () => null,
        });
        const response = await app.request(
          new Request(`${ORIGIN}/files/${UNKNOWN_TOKEN}`),
        );
        expect(response.status).toBe(404);
        expect(keys).toEqual([]);
      });
    });
  });

  describe("dev inbound route", () => {
    test("is absent unless explicitly enabled", async () => {
      const response = await harness.app.request(
        new Request(`${ORIGIN}/dev/inbound`, { method: "POST", body: "x" }),
      );
      expect(response.status).toBe(404);
    });

    test("is reachable when enabled", async () => {
      const app = createApp({
        deps: harness.fake.deps,
        usecases: harness.usecases,
        graphiql: true,
        devInbound: async () => Response.json({ ok: true }),
      });
      const response = await app.request(
        new Request(`${ORIGIN}/dev/inbound`, { method: "POST", body: "x" }),
      );
      expect(response.status).toBe(200);
    });
  });
});
