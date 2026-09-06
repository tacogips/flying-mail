import { createCredentialCipher } from "@mailcal/adapter/crypto/credential-cipher";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildDependencies,
  BuildDependenciesError,
  detectExternalMailRuntime,
  resolveExternalMailRuntime,
} from "./build-dependencies";
import {
  CredentialKeyConfigurationError,
  DEFAULT_FILE_LINK_MAX_TTL_SECONDS,
  DEFAULT_SPAM_THRESHOLD,
  MailConfigurationError,
  PublicOriginConfigurationError,
  assertMailOriginConsistency,
  loadConfigFromEnv,
  normalizeSqliteUrl,
  resolveBlobBackend,
  resolveCredentialKey,
  resolveFileLinkMaxTtl,
  resolveMailFrom,
  resolvePublicOrigin,
  resolveSignupMode,
  resolveSpamThreshold,
} from "./config";

describe("resolvePublicOrigin", () => {
  test("normalizes to scheme and host", () => {
    expect(
      resolvePublicOrigin({
        MAILCAL_PUBLIC_ORIGIN: "https://mail.example.com/some/path/",
      }),
    ).toBe("https://mail.example.com");
  });

  test.each([
    ["unset", {}],
    ["empty", { MAILCAL_PUBLIC_ORIGIN: "" }],
    ["whitespace", { MAILCAL_PUBLIC_ORIGIN: "   " }],
  ])("is undefined when %s", (_label, env) => {
    expect(resolvePublicOrigin(env)).toBeUndefined();
  });

  test.each([
    ["not a url", "mail.example.com"],
    ["an unsupported scheme", "ftp://mail.example.com"],
  ])("throws for %s", (_label, value) => {
    expect(() => resolvePublicOrigin({ MAILCAL_PUBLIC_ORIGIN: value })).toThrow(
      PublicOriginConfigurationError,
    );
  });
});

describe("resolveMailFrom", () => {
  test("accepts a normalized mailbox", () => {
    expect(
      resolveMailFrom({ MAILCAL_MAIL_FROM: " PostMaster@Example.com " }),
    ).toBe("postmaster@example.com");
  });

  test("is undefined when unset", () => {
    expect(resolveMailFrom({})).toBeUndefined();
  });

  test.each(["Name <a@example.com>", "nobody", "a@localhost"])(
    "throws for %j",
    (value) => {
      expect(() => resolveMailFrom({ MAILCAL_MAIL_FROM: value })).toThrow(
        MailConfigurationError,
      );
    },
  );
});

describe("assertMailOriginConsistency", () => {
  test("rejects a sender with no public origin", () => {
    expect(() =>
      assertMailOriginConsistency({
        mailFrom: "a@example.com" as never,
        publicOrigin: undefined,
      }),
    ).toThrow(MailConfigurationError);
  });

  test.each([
    ["both set", "a@example.com", "https://mail.example.com"],
    ["neither set", undefined, undefined],
    ["only an origin", undefined, "https://mail.example.com"],
  ])("accepts %s", (_label, mailFrom, publicOrigin) => {
    expect(() =>
      assertMailOriginConsistency({
        mailFrom: mailFrom as never,
        publicOrigin,
      }),
    ).not.toThrow();
  });
});

describe("scalar env resolution", () => {
  test("signup defaults closed", () => {
    expect(resolveSignupMode({})).toBe("closed");
    expect(resolveSignupMode({ MAILCAL_SIGNUP: "yes" })).toBe("closed");
    expect(resolveSignupMode({ MAILCAL_SIGNUP: "open" })).toBe("open");
  });

  test("spam threshold falls back for anything out of range", () => {
    expect(resolveSpamThreshold({})).toBe(DEFAULT_SPAM_THRESHOLD);
    expect(resolveSpamThreshold({ MAILCAL_SPAM_THRESHOLD: "0.8" })).toBe(0.8);
    expect(resolveSpamThreshold({ MAILCAL_SPAM_THRESHOLD: "0" })).toBe(0);
    for (const bad of ["-1", "2", "nonsense", ""]) {
      expect(resolveSpamThreshold({ MAILCAL_SPAM_THRESHOLD: bad })).toBe(
        DEFAULT_SPAM_THRESHOLD,
      );
    }
  });

  test("file link ttl falls back for anything below the floor", () => {
    expect(resolveFileLinkMaxTtl({})).toBe(DEFAULT_FILE_LINK_MAX_TTL_SECONDS);
    expect(resolveFileLinkMaxTtl({ MAILCAL_FILE_LINK_MAX_TTL: "3600" })).toBe(
      3600,
    );
    for (const bad of ["10", "1.5", "nope"]) {
      expect(resolveFileLinkMaxTtl({ MAILCAL_FILE_LINK_MAX_TTL: bad })).toBe(
        DEFAULT_FILE_LINK_MAX_TTL_SECONDS,
      );
    }
  });

  test("blob backend defaults to r2", () => {
    expect(resolveBlobBackend({})).toBe("r2");
    expect(resolveBlobBackend({ MAILCAL_BLOB_BACKEND: "s3" })).toBe("s3");
    expect(resolveBlobBackend({ MAILCAL_BLOB_BACKEND: "memory" })).toBe(
      "memory",
    );
    expect(resolveBlobBackend({ MAILCAL_BLOB_BACKEND: "nonsense" })).toBe("r2");
  });
});

describe("normalizeSqliteUrl", () => {
  test.each([
    // A bare path is what an operator naturally writes; libsql rejects it
    // with an opaque URL_INVALID, so it is promoted rather than refused.
    ["/tmp/mailcal.db", "file:/tmp/mailcal.db"],
    ["./data/mailcal.db", "file:./data/mailcal.db"],
    ["mailcal.db", "file:mailcal.db"],
  ])("promotes the bare path %j to %j", (input, expected) => {
    expect(normalizeSqliteUrl(input)).toBe(expected);
  });

  test.each([
    ":memory:",
    "file:./data/mailcal.db",
    "libsql://example.turso.io",
    "https://example.turso.io",
  ])("leaves %j untouched", (value) => {
    expect(normalizeSqliteUrl(value)).toBe(value);
  });

  test("falls back to the default for a blank value", () => {
    expect(normalizeSqliteUrl("   ")).toBe("file:./data/mailcal.db");
  });
});

describe("loadConfigFromEnv", () => {
  test("a bare environment yields a runnable local config", () => {
    const config = loadConfigFromEnv({});
    expect(config.sqlBackend).toBe("sqlite");
    expect(config.sqliteUrl).toBe("file:./data/mailcal.db");
    // Local defaults to memory blobs so a clean checkout runs with no setup.
    expect(config.blobBackend).toBe("memory");
    expect(config.signupMode).toBe("closed");
  });

  test("normalizes a bare sqlite path from the environment", () => {
    expect(
      loadConfigFromEnv({ MAILCAL_SQLITE_URL: "/tmp/mailcal.db" }).sqliteUrl,
    ).toBe("file:/tmp/mailcal.db");
  });

  test("honours an explicit s3 backend", () => {
    const config = loadConfigFromEnv({
      MAILCAL_BLOB_BACKEND: "s3",
      MAILCAL_S3_ENDPOINT: "http://localhost:9000",
      MAILCAL_S3_BUCKET: "mailcal",
      MAILCAL_S3_ACCESS_KEY_ID: "key",
      MAILCAL_S3_SECRET_ACCESS_KEY: "secret",
    });
    expect(config.blobBackend).toBe("s3");
    expect(config.s3?.bucket).toBe("mailcal");
    expect(config.s3?.forcePathStyle).toBe(true);
  });

  test("an s3 backend missing a credential fails fast", () => {
    expect(() => loadConfigFromEnv({ MAILCAL_BLOB_BACKEND: "s3" })).toThrow(
      /MAILCAL_S3_ENDPOINT/,
    );
  });
});

describe("buildDependencies", () => {
  test("assembles a working in-memory instance", () => {
    const deps = buildDependencies({
      sqlBackend: "sqlite",
      sqliteUrl: ":memory:",
      blobBackend: "memory",
    });
    expect(deps.messageRepository).toBeDefined();
    expect(deps.mimeParser).toBeDefined();
    expect(deps.instanceConfig.signupMode).toBe("closed");
    expect(deps.instanceConfig.publicOrigin).toBeNull();
    expect(deps.instanceConfig.spamThreshold).toBe(DEFAULT_SPAM_THRESHOLD);
    // External mail's whole port surface is wired even with no
    // MAILCAL_CREDENTIAL_KEY -- the cipher (not a missing field) is what
    // gates its credential-dependent operations.
    expect(deps.tcpDialer).toBeDefined();
    expect(deps.jmapClient).toBeDefined();
    expect(deps.pop3Client).toBeDefined();
    expect(deps.smtpSubmissionClient).toBeDefined();
    expect(deps.externalMailAccountRepository).toBeDefined();
    expect(deps.externalMessageStateRepository).toBeDefined();
  });

  test("installs the unavailable mail sender without a verified sender", async () => {
    const deps = buildDependencies({
      sqlBackend: "sqlite",
      sqliteUrl: ":memory:",
      blobBackend: "memory",
    });
    await expect(
      deps.mailSender.send({
        from: "a@example.com",
        to: ["b@example.com"],
        subject: "x",
        text: "y",
      }),
    ).rejects.toThrow(/Email delivery is unavailable/);
  });

  test("uses the Cloudflare sender when both binding and sender exist", async () => {
    const sent: unknown[] = [];
    const deps = buildDependencies({
      sqlBackend: "sqlite",
      sqliteUrl: ":memory:",
      blobBackend: "memory",
      email: {
        async send(message) {
          sent.push(message);
          return {};
        },
      },
      mailFrom: "postmaster@example.com" as never,
      publicOrigin: "https://mail.example.com",
    });
    await deps.mailSender.send({
      from: "ignored@example.com",
      to: ["b@example.com"],
      subject: "x",
      text: "y",
    });
    expect(sent).toHaveLength(1);
  });

  test.each([
    [
      "d1 without a binding",
      { sqlBackend: "d1" as const, blobBackend: "memory" as const },
    ],
    [
      "r2 without a binding",
      {
        sqlBackend: "sqlite" as const,
        sqliteUrl: ":memory:",
        blobBackend: "r2" as const,
      },
    ],
    [
      "s3 without config",
      {
        sqlBackend: "sqlite" as const,
        sqliteUrl: ":memory:",
        blobBackend: "s3" as const,
      },
    ],
  ])("throws for %s", (_label, config) => {
    expect(() => buildDependencies(config)).toThrow(BuildDependenciesError);
  });
});

describe("external mail runtime selection", () => {
  const originalNavigator = globalThis.navigator;

  /** Stands in for a Workers isolate: `navigator.userAgent` is the
   * platform's own documented, synchronous tell -- see
   * `detectExternalMailRuntime`'s doc comment. */
  function setWorkersNavigator(): void {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "Cloudflare-Workers" },
      configurable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
    });
  });

  test("detects node outside a Workers isolate -- the vitest/Bun environment this test runs in", () => {
    expect(detectExternalMailRuntime()).toBe("node");
  });

  test("detects cloudflare from navigator.userAgent, mirroring wrangler dev/Miniflare", () => {
    setWorkersNavigator();
    expect(detectExternalMailRuntime()).toBe("cloudflare");
  });

  const minimalConfig = {
    sqlBackend: "sqlite",
    blobBackend: "memory",
  } as const;

  test("boots a plain bun run with the node dialer selected, with no config", () => {
    expect(resolveExternalMailRuntime(minimalConfig)).toBe("node");
  });

  test("boots wrangler dev/Miniflare with the cloudflare dialer selected, with no config", () => {
    setWorkersNavigator();
    expect(resolveExternalMailRuntime(minimalConfig)).toBe("cloudflare");
  });

  test("an explicit config.runtime overrides detection either way", () => {
    setWorkersNavigator();
    expect(
      resolveExternalMailRuntime({ ...minimalConfig, runtime: "node" }),
    ).toBe("node");

    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
    });
    expect(
      resolveExternalMailRuntime({ ...minimalConfig, runtime: "cloudflare" }),
    ).toBe("cloudflare");
  });
});

describe("resolveCredentialKey", () => {
  /** base64 of exactly 32 bytes, which is what AES-256-GCM needs. */
  const VALID = btoa("x".repeat(32));

  test("returns the key unchanged when it is a 32-byte base64 value", () => {
    expect(resolveCredentialKey({ MAILCAL_CREDENTIAL_KEY: VALID })).toBe(VALID);
    expect(resolveCredentialKey({ MAILCAL_CREDENTIAL_KEY: ` ${VALID} ` })).toBe(
      VALID,
    );
  });

  test("unset disables encrypted credential operations without misconfiguration", () => {
    // CardDAV and external mail remain available at the schema level; their
    // credential operations report unavailability through the shared cipher.
    expect(resolveCredentialKey({})).toBeUndefined();
    expect(
      resolveCredentialKey({ MAILCAL_CREDENTIAL_KEY: "" }),
    ).toBeUndefined();
    expect(
      resolveCredentialKey({ MAILCAL_CREDENTIAL_KEY: "   " }),
    ).toBeUndefined();
  });

  test("fails fast for a set-but-unusable key", () => {
    // An operator who set the secret meant it to be used; degrading to
    // "no encryption" would store app-specific passwords in the clear.
    for (const value of [
      "not base64!!",
      btoa("too short"),
      btoa("y".repeat(31)),
    ]) {
      expect(() =>
        resolveCredentialKey({ MAILCAL_CREDENTIAL_KEY: value }),
      ).toThrow(CredentialKeyConfigurationError);
    }
  });

  test("loadConfigFromEnv carries the key through, and omits it when unset", () => {
    expect(
      loadConfigFromEnv({ MAILCAL_CREDENTIAL_KEY: VALID }).credentialKey,
    ).toBe(VALID);
    expect(loadConfigFromEnv({}).credentialKey).toBeUndefined();
  });
});

describe("credential cipher availability", () => {
  test("no key yields an unavailable cipher; a key yields a working one", async () => {
    expect(createCredentialCipher(null).available).toBe(false);
    const cipher = createCredentialCipher(btoa("z".repeat(32)));
    expect(cipher.available).toBe(true);
    expect(await cipher.decrypt(await cipher.encrypt("secret"))).toBe("secret");
  });
});
