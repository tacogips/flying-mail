import { afterEach, describe, expect, test, vi } from "vitest";
import { createDohResolver } from "./doh-resolver";

function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createDohResolver", () => {
  test("returns unquoted TXT values", async () => {
    stubFetch({
      Status: 0,
      Answer: [
        { type: 16, data: '"mailcal-verification=tok123"' },
        // A different record type on the same name must be ignored.
        { type: 5, data: "cname.example." },
      ],
    });
    const resolver = createDohResolver();
    expect(await resolver.lookupTxt("_mailcal.example.com")).toEqual([
      "mailcal-verification=tok123",
    ]);
  });

  test("joins the chunked quoted form of long TXT records", async () => {
    stubFetch({
      Status: 0,
      Answer: [{ type: 16, data: '"part-one" "part-two"' }],
    });
    const resolver = createDohResolver();
    expect(await resolver.lookupTxt("x.example.com")).toEqual([
      "part-onepart-two",
    ]);
  });

  test("NXDOMAIN is an empty answer, not an error", async () => {
    stubFetch({ Status: 3 });
    const resolver = createDohResolver();
    expect(await resolver.lookupTxt("missing.example.com")).toEqual([]);
  });

  test("SERVFAIL and HTTP failures reject", async () => {
    stubFetch({ Status: 2 });
    const resolver = createDohResolver();
    await expect(resolver.lookupTxt("x.example.com")).rejects.toThrow(
      "status 2",
    );
    stubFetch({}, 502);
    await expect(resolver.lookupTxt("x.example.com")).rejects.toThrow(
      "HTTP 502",
    );
  });

  test("asks the endpoint for the right name and type", async () => {
    stubFetch({ Status: 0, Answer: [] });
    const resolver = createDohResolver("https://doh.test/dns-query");
    await resolver.lookupTxt("_mailcal.example.com");
    const called = (fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as URL;
    expect(called.origin).toBe("https://doh.test");
    expect(called.searchParams.get("name")).toBe("_mailcal.example.com");
    expect(called.searchParams.get("type")).toBe("TXT");
  });

  test("parses MX records and normalizes exchanges", async () => {
    stubFetch({
      Status: 0,
      Answer: [
        { type: 15, data: "10 ROUTE1.MX.CLOUDFLARE.NET." },
        { type: 5, data: "ignored.example." },
      ],
    });
    const resolver = createDohResolver();
    expect(await resolver.lookupMx("example.com")).toEqual([
      { priority: 10, exchange: "route1.mx.cloudflare.net" },
    ]);
  });

  test("drops the RFC 7505 null MX record", async () => {
    stubFetch({ Status: 0, Answer: [{ type: 15, data: "0 ." }] });
    const resolver = createDohResolver();
    expect(await resolver.lookupMx("example.com")).toEqual([]);
  });

  test("requests MX and rejects MX transport failures", async () => {
    stubFetch({ Status: 0, Answer: [] });
    const resolver = createDohResolver("https://doh.test/dns-query");
    await resolver.lookupMx("example.com");
    const called = (fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as URL;
    expect(called.searchParams.get("type")).toBe("MX");

    stubFetch({ Status: 2 });
    await expect(resolver.lookupMx("example.com")).rejects.toThrow("status 2");
  });
});
