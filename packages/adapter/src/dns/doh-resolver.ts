import type {
  DnsResolver,
  MxRecord,
} from "@flying-mail/application/ports/dns-resolver";

interface DohAnswer {
  readonly type: number;
  readonly data: string;
}

interface DohResponse {
  readonly Status: number;
  readonly Answer?: readonly DohAnswer[];
}

const TXT_TYPE = 16;
const MX_TYPE = 15;
/** NXDOMAIN and NOERROR both mean "we got an authoritative answer"; any
 * other status is a resolution failure worth surfacing. */
const OK_STATUSES = new Set([0, 3]);

async function queryDoh(
  name: string,
  type: "TXT" | "MX",
  endpoint: string,
): Promise<DohResponse> {
  const url = new URL(endpoint);
  url.searchParams.set("name", name);
  url.searchParams.set("type", type);
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
  return body;
}

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
      const body = await queryDoh(name, "TXT", endpoint);
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
    async lookupMx(name): Promise<readonly MxRecord[]> {
      const body = await queryDoh(name, "MX", endpoint);
      return (body.Answer ?? []).flatMap((answer) => {
        if (answer.type !== MX_TYPE) return [];
        const match = /^(\d+)\s+(.+)$/.exec(answer.data.trim());
        if (match === null) {
          throw new Error("DNS lookup returned an invalid MX record");
        }
        const priority = Number(match[1]);
        const exchange = match[2];
        if (!Number.isSafeInteger(priority) || exchange === undefined) {
          throw new Error("DNS lookup returned an invalid MX record");
        }
        if (exchange === ".") return [];
        return [
          {
            priority,
            exchange: exchange.toLowerCase().replace(/\.$/, ""),
          },
        ];
      });
    },
  };
}
