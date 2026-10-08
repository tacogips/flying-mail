import { createCredentialCipher } from "@flying-mail/adapter/crypto/credential-cipher";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildDependencies,
  BuildDependenciesError,
  detectExternalMailRuntime,
  resolveExternalMailRuntime,
} from "./build-dependencies";
import {
  BootstrapTokenConfigurationError,
  CredentialKeyConfigurationError,
  DEFAULT_FILE_LINK_MAX_TTL_SECONDS,
  DEFAULT_INVITE_TTL_SECONDS,
  DEFAULT_INBOUND_MX_SUFFIX,
  DEFAULT_SPAM_THRESHOLD,
  MailConfigurationError,
  PublicOriginConfigurationError,
  TurnstileConfigurationError,
  assertMailOriginConsistency,
  loadConfigFromEnv,
  normalizeSqliteUrl,
  normalizeClientIpForRateLimit,
  resolveBlobBackend,
  resolveBootstrapToken,
  resolveCredentialKey,
  resolveFileLinkMaxTtl,
  resolveInviteTtlSeconds,
  resolveInboundMxSuffix,
  resolveMailFrom,
  resolvePublicOrigin,
  resolveSpamThreshold,
  resolveTurnstileConfig,
} from "./config";

describe("resolvePublicOrigin", () => {
  test("normalizes to scheme and host", () => {
    expect(
      resolvePublicOrigin({
        FLYING_MAIL_PUBLIC_ORIGIN: "https://mail.example.com/some/path/",
      }),
    ).toBe("https://mail.example.com");
  });

  test.each([
    ["unset", {}],
    ["empty", { FLYING_MAIL_PUBLIC_ORIGIN: "" }],
    ["whitespace", { FLYING_MAIL_PUBLIC_ORIGIN: "   " }],
  ])("is undefined when %s", (_label, env) => {
    expect(resolvePublicOrigin(env)).toBeUndefined();
  });

  test.each([
    ["not a url", "mail.example.com"],
    ["an unsupported scheme", "ftp://mail.example.com"],
  ])("throws for %s", (_label, value) => {
    expect(() =>
      resolvePublicOrigin({ FLYING_MAIL_PUBLIC_ORIGIN: value }),
    ).toThrow(PublicOriginConfigurationError);
  });
});

describe("resolveMailFrom", () => {
  test("accepts a normalized mailbox", () => {
    expect(
      resolveMailFrom({ FLYING_MAIL_MAIL_FROM: " PostMaster@Example.com " }),
    ).toBe("postmaster@example.com");
  });

  test("is undefined when unset", () => {
    expect(resolveMailFrom({})).toBeUndefined();
  });

  test.each(["Name <a@example.com>", "nobody", "a@localhost"])(
    "throws for %j",
    (value) => {
      expect(() => resolveMailFrom({ FLYING_MAIL_MAIL_FROM: value })).toThrow(
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
  test("spam threshold falls back for anything out of range", () => {
    expect(resolveSpamThreshold({})).toBe(DEFAULT_SPAM_THRESHOLD);
    expect(resolveSpamThreshold({ FLYING_MAIL_SPAM_THRESHOLD: "0.8" })).toBe(
      0.8,
    );
    expect(resolveSpamThreshold({ FLYING_MAIL_SPAM_THRESHOLD: "0" })).toBe(0);
    for (const bad of ["-1", "2", "nonsense", ""]) {
      expect(resolveSpamThreshold({ FLYING_MAIL_SPAM_THRESHOLD: bad })).toBe(
        DEFAULT_SPAM_THRESHOLD,
      );
    }
  });

  test("file link ttl falls back for anything below the floor", () => {
    expect(resolveFileLinkMaxTtl({})).toBe(DEFAULT_FILE_LINK_MAX_TTL_SECONDS);
    expect(
      resolveFileLinkMaxTtl({ FLYING_MAIL_FILE_LINK_MAX_TTL: "3600" }),
    ).toBe(3600);
    for (const bad of ["10", "1.5", "nope"]) {
      expect(
        resolveFileLinkMaxTtl({ FLYING_MAIL_FILE_LINK_MAX_TTL: bad }),
      ).toBe(DEFAULT_FILE_LINK_MAX_TTL_SECONDS);
    }
  });

  test("inbound MX suffix defaults to Cloudflare and empty disables the gate", () => {
    expect(resolveInboundMxSuffix({})).toBe(DEFAULT_INBOUND_MX_SUFFIX);
    expect(
      resolveInboundMxSuffix({
        FLYING_MAIL_INBOUND_MX_SUFFIX: "  MX.Example. ",
      }),
    ).toBe("mx.example");
    expect(resolveInboundMxSuffix({ FLYING_MAIL_INBOUND_MX_SUFFIX: "" })).toBe(
      null,
    );
    expect(
      resolveInboundMxSuffix({ FLYING_MAIL_INBOUND_MX_SUFFIX: "   " }),
    ).toBe(null);
  });

  test("blob backend defaults to r2", () => {
    expect(resolveBlobBackend({})).toBe("r2");
    expect(resolveBlobBackend({ FLYING_MAIL_BLOB_BACKEND: "s3" })).toBe("s3");
    expect(resolveBlobBackend({ FLYING_MAIL_BLOB_BACKEND: "memory" })).toBe(
      "memory",
    );
    expect(resolveBlobBackend({ FLYING_MAIL_BLOB_BACKEND: "nonsense" })).toBe(
      "r2",
    );
  });
});

describe("resolveInviteTtlSeconds", () => {
  test.each([
    ["unset", undefined, DEFAULT_INVITE_TTL_SECONDS],
    ["minimum", "86400", 86400],
    ["maximum", "2592000", 2592000],
    ["below minimum", "3600", DEFAULT_INVITE_TTL_SECONDS],
    ["non-integer", "abc", DEFAULT_INVITE_TTL_SECONDS],
    ["fractional", "90000.5", DEFAULT_INVITE_TTL_SECONDS],
  ] as const)("resolves %s", (_label, value, expected) => {
    expect(
      resolveInviteTtlSeconds(
        value === undefined ? {} : { FLYING_MAIL_INVITE_TTL_SECONDS: value },
      ),
    ).toBe(expected);
  });
});

describe("resolveBootstrapToken", () => {
  test.each(["unset", "blank"])("disables bootstrap when %s", (kind) => {
    const env = kind === "unset" ? {} : { FLYING_MAIL_BOOTSTRAP_TOKEN: "  " };
    expect(resolveBootstrapToken(env)).toBeUndefined();
  });

  test("rejects short tokens without including their value in the error", () => {
    const token = "sensitive-short-token-value-123";
    try {
      resolveBootstrapToken({ FLYING_MAIL_BOOTSTRAP_TOKEN: token });
      throw new Error("Expected a configuration error");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(BootstrapTokenConfigurationError);
      expect(error instanceof Error ? error.message : "").not.toContain(token);
    }
  });

  test("returns a 32-character token trimmed", () => {
    const token = "a".repeat(32);
    expect(
      resolveBootstrapToken({ FLYING_MAIL_BOOTSTRAP_TOKEN: ` ${token} ` }),
    ).toBe(token);
  });
});

describe("resolveTurnstileConfig", () => {
  test("disables Turnstile without a secret, including when only the site key is set", () => {
    expect(resolveTurnstileConfig({}, undefined)).toBeUndefined();
    expect(
      resolveTurnstileConfig(
        { FLYING_MAIL_TURNSTILE_SITE_KEY: "public-site-key" },
        undefined,
      ),
    ).toBeUndefined();
  });

  test("requires a site key and public origin when the secret is set", () => {
    const secret = "private-turnstile-secret";
    expect(() =>
      resolveTurnstileConfig(
        { FLYING_MAIL_TURNSTILE_SECRET_KEY: secret },
        "https://mail.example.com",
      ),
    ).toThrow(TurnstileConfigurationError);
    expect(() =>
      resolveTurnstileConfig(
        {
          FLYING_MAIL_TURNSTILE_SECRET_KEY: secret,
          FLYING_MAIL_TURNSTILE_SITE_KEY: "public-site-key",
        },
        undefined,
      ),
    ).toThrow(TurnstileConfigurationError);
  });

  test("masks the secret when the public origin is invalid", () => {
    const secret = "private-turnstile-secret";
    try {
      resolveTurnstileConfig(
        {
          FLYING_MAIL_TURNSTILE_SECRET_KEY: secret,
          FLYING_MAIL_TURNSTILE_SITE_KEY: "public-site-key",
        },
        "not-a-url",
      );
      throw new Error("Expected a configuration error");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(TurnstileConfigurationError);
      expect(error instanceof Error ? error.message : "").not.toContain(secret);
    }
  });

  test("trims settings and derives the expected hostname", () => {
    expect(
      resolveTurnstileConfig(
        {
          FLYING_MAIL_TURNSTILE_SECRET_KEY: " private-secret ",
          FLYING_MAIL_TURNSTILE_SITE_KEY: " public-site-key ",
        },
        "https://mail.tacoserve.online",
      ),
    ).toEqual({
      secret: "private-secret",
      siteKey: "public-site-key",
      expectedHostname: "mail.tacoserve.online",
    });
  });
});

describe("normalizeClientIpForRateLimit", () => {
  test.each([
    ["192.0.2.1", "192.0.2.1"],
    ["::ffff:192.0.2.1", "192.0.2.1"],
    ["0:0:0:0:0:ffff:c000:201", "192.0.2.1"],
  ])("keeps IPv4 address identity for %s", (input, expected) => {
    expect(normalizeClientIpForRateLimit(input)).toBe(expected);
  });

  test.each([
    ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
    ["2001:0db8:0001:0002:ffff::1", "2001:db8:1:2::/64"],
    ["2001:db8:1:3::1", "2001:db8:1:3::/64"],
  ])("groups IPv6 addresses by /64 for %s", (input, expected) => {
    expect(normalizeClientIpForRateLimit(input)).toBe(expected);
  });

  test.each([null, "", "   ", "not-an-ip"])(
    "returns null for invalid or empty client IP %j",
    (input) => {
      expect(normalizeClientIpForRateLimit(input)).toBeNull();
    },
  );
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
    expect(config.inboundMxSuffix).toBe(DEFAULT_INBOUND_MX_SUFFIX);
    expect(config.inviteTtlSeconds).toBe(DEFAULT_INVITE_TTL_SECONDS);
  });

  test("resolves auth settings for the local server", () => {
    const config = loadConfigFromEnv({
      FLYING_MAIL_INVITE_TTL_SECONDS: "2592000",
      FLYING_MAIL_BOOTSTRAP_TOKEN: ` ${"t".repeat(32)} `,
      FLYING_MAIL_PUBLIC_ORIGIN: "https://mail.tacoserve.online",
      FLYING_MAIL_TURNSTILE_SECRET_KEY: " private-secret ",
      FLYING_MAIL_TURNSTILE_SITE_KEY: " public-site-key ",
    });
    expect(config.inviteTtlSeconds).toBe(2592000);
    expect(config.bootstrapToken).toBe("t".repeat(32));
    expect(config.turnstile).toEqual({
      secret: "private-secret",
      siteKey: "public-site-key",
      expectedHostname: "mail.tacoserve.online",
    });
    expect(config.rateLimiter).toBeUndefined();
  });

  test("an empty inbound MX suffix disables the gate", () => {
    expect(
      loadConfigFromEnv({ FLYING_MAIL_INBOUND_MX_SUFFIX: "" }).inboundMxSuffix,
    ).toBeNull();
  });

  test("normalizes a bare sqlite path from the environment", () => {
    expect(
      loadConfigFromEnv({ FLYING_MAIL_SQLITE_URL: "/tmp/mailcal.db" })
        .sqliteUrl,
    ).toBe("file:/tmp/mailcal.db");
  });

  test("honours an explicit s3 backend", () => {
    const config = loadConfigFromEnv({
      FLYING_MAIL_BLOB_BACKEND: "s3",
      FLYING_MAIL_S3_ENDPOINT: "http://localhost:9000",
      FLYING_MAIL_S3_BUCKET: "mailcal",
      FLYING_MAIL_S3_ACCESS_KEY_ID: "key",
      FLYING_MAIL_S3_SECRET_ACCESS_KEY: "secret",
    });
    expect(config.blobBackend).toBe("s3");
    expect(config.s3?.bucket).toBe("mailcal");
    expect(config.s3?.forcePathStyle).toBe(true);
  });

  test("an s3 backend missing a credential fails fast", () => {
    expect(() => loadConfigFromEnv({ FLYING_MAIL_BLOB_BACKEND: "s3" })).toThrow(
      /FLYING_MAIL_S3_ENDPOINT/,
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
    expect(deps.instanceConfig.publicOrigin).toBeNull();
    expect(deps.instanceConfig.spamThreshold).toBe(DEFAULT_SPAM_THRESHOLD);
    expect(deps.instanceConfig.inboundMxSuffix).toBe(DEFAULT_INBOUND_MX_SUFFIX);
    // External mail's whole port surface is wired even with no
    // FLYING_MAIL_CREDENTIAL_KEY -- the cipher (not a missing field) is what
    // gates its credential-dependent operations.
    expect(deps.tcpDialer).toBeDefined();
    expect(deps.jmapClient).toBeDefined();
    expect(deps.pop3Client).toBeDefined();
    expect(deps.smtpSubmissionClient).toBeDefined();
    expect(deps.externalMailAccountRepository).toBeDefined();
    expect(deps.externalMessageStateRepository).toBeDefined();
    expect(deps.turnstileVerifier).toBeNull();
    expect(deps.instanceConfig.turnstileSiteKey).toBeNull();
    expect(deps.rateLimiter).toBeNull();
  });

  test("wires Turnstile and rate limiting only when configured", () => {
    const rateLimiter = {
      async limit() {
        return true;
      },
    };
    const deps = buildDependencies({
      sqlBackend: "sqlite",
      sqliteUrl: ":memory:",
      blobBackend: "memory",
      inviteTtlSeconds: 86400,
      bootstrapToken: "b".repeat(32),
      turnstile: {
        secret: "private-secret",
        siteKey: "public-site-key",
        expectedHostname: "mail.example.com",
      },
      rateLimiter,
    });
    expect(deps.turnstileVerifier).not.toBeNull();
    expect(deps.instanceConfig.turnstileSiteKey).toBe("public-site-key");
    expect(deps.rateLimiter).toBe(rateLimiter);
    expect(deps.instanceConfig.inviteTtlSeconds).toBe(86400);
    expect(deps.instanceConfig.bootstrapToken).toBe("b".repeat(32));
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
    expect(resolveCredentialKey({ FLYING_MAIL_CREDENTIAL_KEY: VALID })).toBe(
      VALID,
    );
    expect(
      resolveCredentialKey({ FLYING_MAIL_CREDENTIAL_KEY: ` ${VALID} ` }),
    ).toBe(VALID);
  });

  test("unset disables encrypted credential operations without misconfiguration", () => {
    // CardDAV and external mail remain available at the schema level; their
    // credential operations report unavailability through the shared cipher.
    expect(resolveCredentialKey({})).toBeUndefined();
    expect(
      resolveCredentialKey({ FLYING_MAIL_CREDENTIAL_KEY: "" }),
    ).toBeUndefined();
    expect(
      resolveCredentialKey({ FLYING_MAIL_CREDENTIAL_KEY: "   " }),
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
        resolveCredentialKey({ FLYING_MAIL_CREDENTIAL_KEY: value }),
      ).toThrow(CredentialKeyConfigurationError);
    }
  });

  test("loadConfigFromEnv carries the key through, and omits it when unset", () => {
    expect(
      loadConfigFromEnv({ FLYING_MAIL_CREDENTIAL_KEY: VALID }).credentialKey,
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
