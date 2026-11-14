import { describe, expect, test } from "vitest";
import { createCloudflareTcpDialer } from "./cloudflare-tcp-dialer";

/** Bun/Node has no `cloudflare:sockets` module. This suite only asserts the
 * import-safety property the plan calls for -- loading and constructing the
 * dialer never touches `cloudflare:sockets` (`connect` is imported lazily
 * inside `dial()`) -- plus that a `dial()` call here rejects rather than
 * throwing synchronously or crashing the process. Dialing for real is only
 * exercisable under `wrangler dev`/Miniflare, per the plan's "skipping the
 * Cloudflare one outside `wrangler dev`/Miniflare"; `node-tcp-dialer.test.ts`
 * covers the same `TcpDialer` contract against a real loopback socket. */
describe("cloudflare-tcp-dialer", () => {
  test("importing and constructing the dialer does not touch cloudflare:sockets", () => {
    expect(() => createCloudflareTcpDialer()).not.toThrow();
  });

  test("dial() rejects (rather than throwing synchronously) outside workerd", async () => {
    const dialer = createCloudflareTcpDialer();
    const dialPromise = dialer.dial({
      host: "pop.example.com",
      port: 995,
      tls: "implicit",
    });
    await expect(dialPromise).rejects.toBeTruthy();
  });
});
