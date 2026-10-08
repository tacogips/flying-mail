import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createSecurityHeadersMiddleware, HTML_CSP } from "./security-headers";

const HEADERS_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../apps/web/public/_headers",
);
const EXPECTED_HTML_CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' https://challenges.cloudflare.com; frame-src 'self' blob: https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

describe("HTML content security policy", () => {
  test("matches the complete expected policy", () => {
    expect(HTML_CSP).toBe(EXPECTED_HTML_CSP);
    expect(HTML_CSP.match(/connect-src 'self'/g)).toHaveLength(1);
    expect(HTML_CSP).not.toMatch(/\b(?:ws|wss):/);
  });

  test("allows Turnstile in script-src and frame-src only", () => {
    const directives = HTML_CSP.split("; ");
    expect(directives).toContain(
      "script-src 'self' https://challenges.cloudflare.com",
    );
    expect(directives).toContain(
      "frame-src 'self' blob: https://challenges.cloudflare.com",
    );
    const secureOrigins = HTML_CSP.match(/https:\/\/[^\s;]+/g) ?? [];
    expect(secureOrigins).toEqual([
      "https://challenges.cloudflare.com",
      "https://challenges.cloudflare.com",
    ]);
  });

  test("matches the static web shell CSP", () => {
    const headers = readFileSync(HEADERS_FILE, "utf8");
    const match = headers.match(/Content-Security-Policy:\s*(.+)/);
    expect(match?.[1]).toBe(HTML_CSP);
    expect(match?.[1]?.match(/connect-src 'self'/g)).toHaveLength(1);
    expect(match?.[1]).not.toMatch(/\b(?:ws|wss):/);
  });

  test("adds the policy to HTML responses", async () => {
    const app = new Hono();
    app.use("*", createSecurityHeadersMiddleware());
    app.get("/", (context) =>
      context.html("<!doctype html><title>Mail</title>"),
    );

    const response = await app.request("/");
    expect(response.headers.get("content-security-policy")).toBe(HTML_CSP);
  });
});
