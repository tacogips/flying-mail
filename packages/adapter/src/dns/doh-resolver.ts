import type { DnsResolver } from "@mailcal/application/ports/dns-resolver";

interface DohAnswer {
  readonly type: number;
  readonly data: string;
}

interface DohResponse {
  readonly Status: number;
  readonly Answer?: readonly DohAnswer[];
}

const TXT_TYPE = 16;
/** NXDOMAIN and NOERROR both mean "we got an authoritative answer"; any
 * other status is a resolution failure worth surfacing. */
const OK_STATUSES = new Set([0, 3]);

/** DNS-over-HTTPS resolver (RFC 8484 JSON form).
 *
 * Chosen over a raw resolver because it is the only DNS mechanism
 * available inside a Cloudflare Worker, and it behaves identically on the
 * local Bun server -- one code path for both deployments. */
export function createDohResolver(
  endpoint = "https://cloudflare-dns.com/dns-query",
): DnsResolver {
  return {
    async lookupTxt(name) {
      const url = new URL(endpoint);
      url.searchParams.set("name", name);
      url.searchParams.set("type", "TXT");
      const response = await fetch(url, {
        headers: { accept: "application/dns-json" },
      });
      if (!response.ok) {
        throw new Error(`DNS lookup failed with HTTP ${response.status}`);
      }
      const body = (await response.json()) as DohResponse;
      if (!OK_STATUSES.has(body.Status)) {
        throw new Error(`DNS lookup failed with status ${body.Status}`);
      }
      return (
        (body.Answer ?? [])
          .filter((answer) => answer.type === TXT_TYPE)
          // TXT data arrives as one or more quoted strings; long records are
          // split into adjacent quoted chunks that concatenate.
          .map((answer) =>
            answer.data.replace(/^"|"$/g, "").replace(/"\s*"/g, ""),
          )
      );
    },
  };
}
