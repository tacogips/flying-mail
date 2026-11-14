import { verifyMailDomain } from "@mailcal/domain/entities/mail-domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLocalApp, detectRuntime } from "./server";

const ORIGIN = "http://localhost:8787";

const SAMPLE_EML = [
  "From: Sender <sender@other.com>",
  "To: support@example.com",
  "Subject: Local dev message",
  "Message-ID: <local-1@other.com>",
  "Content-Type: text/plain",
  "",
  "Hello from the dev route.",
  "",
].join("\r\n");

describe("detectRuntime", () => {
  test("reports the runtime the suite is running under", () => {
    expect(["bun", "node"]).toContain(detectRuntime());
  });
});

describe("createLocalApp", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // A throwaway in-memory database per test, so migrations run fresh.
    process.env["MAILCAL_SQLITE_URL"] = ":memory:";
    process.env["MAILCAL_BLOB_BACKEND"] = "memory";
    delete process.env["MAILCAL_PUBLIC_ORIGIN"];
    delete process.env["MAILCAL_MAIL_FROM"];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("applies migrations before serving a request", async () => {
    const { app, deps } = await createLocalApp();

    // The schema exists, so a query that depends on it succeeds rather than
    // failing with "no such table".
    const tags = await deps.tagRepository.list();
    expect(tags.length).toBeGreaterThanOrEqual(3);

    const response = await app.request(
      new Request(`${ORIGIN}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { capabilities } }" }),
      }),
    );
    expect(response.status).toBe(200);
  });

  test("seeds the system tags (SPAM retired to message_spam)", async () => {
    const { deps } = await createLocalApp();
    const slugs = (await deps.tagRepository.list())
      .filter((tag) => tag.systemSlug !== null)
      .map((tag) => tag.systemSlug)
      .sort();
    expect(slugs).toEqual(["ARCHIVED", "STARRED", "TRASH"]);
  });

  test("the dev inbound route round-trips a raw message", async () => {
    const { app, deps, usecases } = await createLocalApp();

    // The route needs a managed, active domain, exactly like production.
    const { user } = await usecases.bootstrapAdmin(
      "admin@example.com",
      "Admin",
    );
    const viewer = {
      kind: "USER" as const,
      userId: user.id,
      role: user.role,
      permissions: [],
      templatePermissions: [],
      calendarPermissions: [],
    };
    const domain = await usecases.createDomain(viewer, "example.com", true);
    // Activate directly at the repository: verifyDomain now performs a
    // real DNS-over-HTTPS lookup, and a unit test must not touch the
    // network (nor own the example.com zone).
    await deps.mailDomainRepository.save(
      verifyMailDomain(domain, new Date().toISOString()),
    );

    const response = await app.request(
      new Request(
        `${ORIGIN}/dev/inbound?from=sender@other.com&to=support@example.com`,
        { method: "POST", body: SAMPLE_EML },
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      kind: string;
      subject: string;
    };
    expect(body.kind).toBe("STORED");
    expect(body.subject).toBe("Local dev message");

    const page = await deps.messageRepository.list(
      { allowedPatterns: null, mailPermissionFilter: null },
      10,
      null,
    );
    expect(page.totalCount).toBe(1);
  });

  test("the dev inbound route rejects an unmanaged recipient", async () => {
    const { app } = await createLocalApp();
    const response = await app.request(
      new Request(
        `${ORIGIN}/dev/inbound?from=sender@other.com&to=someone@unmanaged.com`,
        { method: "POST", body: SAMPLE_EML },
      ),
    );
    expect(response.status).toBe(422);
  });

  test("the dev inbound route requires both envelope parameters", async () => {
    const { app } = await createLocalApp();
    const response = await app.request(
      new Request(`${ORIGIN}/dev/inbound`, {
        method: "POST",
        body: SAMPLE_EML,
      }),
    );
    expect(response.status).toBe(400);
  });
});
