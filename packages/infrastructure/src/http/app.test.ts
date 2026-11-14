import { Capability } from "@mailcal/domain/entities/api-key";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "@mailcal/application/test-support/fakes";
import { createUseCases, type UseCases } from "@mailcal/application/usecases";
import { createAttachment } from "@mailcal/domain/entities/attachment";
import {
  createMailDomain,
  verifyMailDomain,
} from "@mailcal/domain/entities/mail-domain";
import {
  createInboundMessage,
  RecipientKind,
} from "@mailcal/domain/entities/message";
import { createSession } from "@mailcal/domain/entities/session";
import { createUser, UserRole } from "@mailcal/domain/entities/user";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createAttachmentId,
  createDomainId,
  createMessageId,
  createSessionId,
  createThreadId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
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
      calendarPermissions: [],
    },
    {
      name: "agent",
      scopes: [
        { capability: Capability.MailRead, domainId, addressPattern: "*" },
        { capability: Capability.FileLink, domainId, addressPattern: "*" },
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

    describe("event-claimed attachments", () => {
      const OWNER_VIEWER = {
        kind: "USER",
        userId: createUserId("usr-1"),
        role: UserRole.Admin,
        permissions: [],
        templatePermissions: [],
        calendarPermissions: [],
      } as const;

      /** Uploads a file as the session user and claims it for a new event,
       * returning the attachment id and the event's calendar. */
      async function stageClaimedAttachment(
        mentions: readonly string[] = [],
      ): Promise<string> {
        const form = new FormData();
        form.set(
          "file",
          new File(["agenda"], "agenda.pdf", { type: "application/pdf" }),
        );
        const uploaded = (await (
          await harness.app.request(
            new Request(`${ORIGIN}/api/attachments`, {
              method: "POST",
              headers: {
                cookie: `${SESSION_COOKIE_NAME}=${harness.sessionToken}`,
              },
              body: form,
            }),
          )
        ).json()) as { id: string };

        const calendar = await harness.usecases.createCalendar(OWNER_VIEWER, {
          name: "Work",
        });
        const event = await harness.usecases.createCalendarEvent(OWNER_VIEWER, {
          calendarId: calendar.id,
          title: "Review",
          time: {
            allDay: false,
            startsAt: "2026-09-01T00:00:00.000Z",
            endsAt: "2026-09-01T01:00:00.000Z",
          },
          mentions,
        });
        await harness.usecases.attachFileToEvent(
          OWNER_VIEWER,
          event.id,
          createAttachmentId(uploaded.id),
        );
        return uploaded.id;
      }

      function download(id: string, headers: Record<string, string>) {
        return harness.app.request(
          new Request(`${ORIGIN}/api/attachments/${id}`, { headers }),
        );
      }

      test("the calendar owner downloads it", async () => {
        const id = await stageClaimedAttachment();
        const response = await download(id, {
          cookie: `${SESSION_COOKIE_NAME}=${harness.sessionToken}`,
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("agenda");
      });

      test("a mentioned user downloads it", async () => {
        const mentioned = createUser({
          id: createUserId("usr-mentioned"),
          email: createEmailAddress("guest@example.com"),
          name: "Guest",
          role: UserRole.Member,
          createdAt: NOW,
        });
        harness.fake.stores.users.set(mentioned.id, mentioned);
        const mentionedToken = "mentioned-session";
        harness.fake.stores.sessions.set(
          "ses-mentioned",
          createSession({
            id: createSessionId("ses-mentioned"),
            tokenHash: `hash(${mentionedToken})`,
            userId: mentioned.id,
            expiresAt: "2026-09-23T00:00:00.000Z",
            createdAt: NOW,
          }),
        );

        const id = await stageClaimedAttachment(["guest@example.com"]);
        const response = await download(id, {
          cookie: `${SESSION_COOKIE_NAME}=${mentionedToken}`,
        });
        expect(response.status).toBe(200);
      });

      test("an unrelated user gets 404, never 403", async () => {
        const stranger = createUser({
          id: createUserId("usr-stranger"),
          email: createEmailAddress("stranger@example.com"),
          name: "Stranger",
          role: UserRole.Member,
          createdAt: NOW,
        });
        harness.fake.stores.users.set(stranger.id, stranger);
        const strangerToken = "stranger-session";
        harness.fake.stores.sessions.set(
          "ses-stranger",
          createSession({
            id: createSessionId("ses-stranger"),
            tokenHash: `hash(${strangerToken})`,
            userId: stranger.id,
            expiresAt: "2026-09-23T00:00:00.000Z",
            createdAt: NOW,
          }),
        );

        const id = await stageClaimedAttachment();
        const response = await download(id, {
          cookie: `${SESSION_COOKIE_NAME}=${strangerToken}`,
        });
        expect(response.status).toBe(404);
      });

      test("a mail-only scoped key gets 404", async () => {
        const id = await stageClaimedAttachment();
        const response = await download(id, {
          authorization: `Bearer ${harness.apiKeySecret}`,
        });
        expect(response.status).toBe(404);
      });

      test("an unclaimed staged upload stays undownloadable", async () => {
        const form = new FormData();
        form.set("file", new File(["data"], "notes.txt"));
        const uploaded = (await (
          await harness.app.request(
            new Request(`${ORIGIN}/api/attachments`, {
              method: "POST",
              headers: {
                cookie: `${SESSION_COOKIE_NAME}=${harness.sessionToken}`,
              },
              body: form,
            }),
          )
        ).json()) as { id: string };
        const response = await download(uploaded.id, {
          cookie: `${SESSION_COOKIE_NAME}=${harness.sessionToken}`,
        });
        expect(response.status).toBe(404);
      });

      test("message attachments are unregressed", async () => {
        const response = await download(attachmentId, {
          authorization: `Bearer ${harness.apiKeySecret}`,
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("hello");
      });
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
          calendarPermissions: [],
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
