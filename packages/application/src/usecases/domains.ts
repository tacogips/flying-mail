import { Capability } from "@flying-mail/domain/entities/api-key";
import {
  createMailDomain,
  DomainStatus,
  type MailDomain,
  setMailDomainStatus,
  verifyMailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import {
  createDomainId,
  type DomainId,
} from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import type { MxRecord } from "../ports/dns-resolver";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors";
import {
  requireGlobalCapability,
  scopedDomainIds,
} from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

/** Bytes of randomness in the DNS ownership token. */
const VERIFICATION_TOKEN_BYTES = 24;

export enum InboundMxStatus {
  Ready = "READY",
  NotCloudflare = "NOT_CLOUDFLARE",
  None = "NONE",
  Unknown = "UNKNOWN",
}

export interface DnsRecord {
  readonly type: "TXT" | "MX" | "CNAME";
  readonly name: string;
  readonly value: string;
  readonly priority: number | null;
  readonly purpose: string;
}

/** Classifies authoritative MX results against the configured provider suffix. */
export function classifyInboundMx(
  records: readonly MxRecord[],
  suffix: string,
):
  | InboundMxStatus.Ready
  | InboundMxStatus.NotCloudflare
  | InboundMxStatus.None {
  if (records.length === 0) return InboundMxStatus.None;
  const normalizedSuffix = suffix.toLowerCase().replace(/\.$/, "");
  return records.some(({ exchange }) => {
    const normalizedExchange = exchange.toLowerCase().replace(/\.$/, "");
    return (
      normalizedExchange === normalizedSuffix ||
      normalizedExchange.endsWith(`.${normalizedSuffix}`)
    );
  })
    ? InboundMxStatus.Ready
    : InboundMxStatus.NotCloudflare;
}

/** Best-effort MX status used by the settings view. */
export function createInboundMxStatusUseCase(
  deps: AppDependencies,
): (domain: MailDomain) => Promise<InboundMxStatus> {
  return async (domain) => {
    const suffix = deps.instanceConfig.inboundMxSuffix;
    if (suffix === null) return InboundMxStatus.Unknown;
    try {
      return classifyInboundMx(await deps.dns.lookupMx(domain.name), suffix);
    } catch {
      return InboundMxStatus.Unknown;
    }
  };
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The records an operator must publish for a domain to receive and send.
 * Returned by the API so the settings UI and the CLI show the same list,
 * rather than each hard-coding its own copy. */
export function buildDomainDnsRecords(
  domain: MailDomain,
): readonly DnsRecord[] {
  return [
    {
      type: "TXT",
      name: `_mailcal.${domain.name}`,
      value: `mailcal-verification=${domain.verificationToken}`,
      priority: null,
      purpose: "Proves you control this domain",
    },
    {
      type: "MX",
      name: domain.name,
      value: "route1.mx.cloudflare.net",
      priority: 1,
      purpose: "Routes inbound mail to Cloudflare Email Routing",
    },
    {
      type: "MX",
      name: domain.name,
      value: "route2.mx.cloudflare.net",
      priority: 2,
      purpose: "Routes inbound mail to Cloudflare Email Routing",
    },
    {
      type: "MX",
      name: domain.name,
      value: "route3.mx.cloudflare.net",
      priority: 3,
      purpose: "Routes inbound mail to Cloudflare Email Routing",
    },
    {
      type: "TXT",
      name: domain.name,
      value: "v=spf1 include:_spf.mx.cloudflare.net ~all",
      priority: null,
      purpose: "Authorizes Cloudflare to send mail for this domain",
    },
  ];
}

/** Domains an API key can reach through its scopes; a user sees all. */
function visibleDomains(
  viewer: Viewer,
  domains: readonly MailDomain[],
): readonly MailDomain[] {
  if (viewer.kind === "USER") {
    return domains;
  }
  const readable = new Set<string>();
  let unrestricted = false;
  for (const scope of viewer.scopes) {
    if (scope.domainId === null) {
      unrestricted = true;
      break;
    }
    readable.add(scope.domainId);
  }
  return unrestricted
    ? domains
    : domains.filter((domain) => readable.has(domain.id));
}

export function createListDomainsUseCase(
  deps: AppDependencies,
): (viewer: Viewer) => Promise<readonly MailDomain[]> {
  return async (viewer) =>
    visibleDomains(viewer, await deps.mailDomainRepository.list());
}

export function createGetDomainUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: DomainId) => Promise<MailDomain | null> {
  return async (viewer, id) => {
    const domain = await deps.mailDomainRepository.findById(id);
    if (domain === null) {
      return null;
    }
    const scoped = scopedDomainIds(viewer, Capability.MailRead);
    if (viewer.kind === "API_KEY" && scoped !== null && !scoped.includes(id)) {
      // Out of scope reads as absent, matching the message read rule.
      return null;
    }
    return domain;
  };
}

export function createCreateDomainUseCase(
  deps: AppDependencies,
): (viewer: Viewer, name: string, catchAll: boolean) => Promise<MailDomain> {
  return async (viewer, name, catchAll) =>
    withAsyncDomainErrorTranslation(async () => {
      requireGlobalCapability(viewer, Capability.DomainAdmin);
      const domainName = createDomainName(name, "name");
      const existing = await deps.mailDomainRepository.findByName(domainName);
      if (existing !== null) {
        throw new ConflictError(`Domain ${domainName} is already managed`);
      }
      const domain = createMailDomain({
        id: createDomainId(deps.random.uuid()),
        name: domainName,
        catchAll,
        verificationToken: toHex(
          deps.random.tokenBytes(VERIFICATION_TOKEN_BYTES),
        ),
        createdAt: deps.clock.now().toISOString(),
      });
      await deps.mailDomainRepository.save(domain);
      return domain;
    });
}

/** Checks ownership and inbound routing before activating a domain. */
export function createVerifyDomainUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: DomainId) => Promise<MailDomain> {
  return async (viewer, id) =>
    withAsyncDomainErrorTranslation(async () => {
      requireGlobalCapability(viewer, Capability.DomainAdmin);
      const domain = await deps.mailDomainRepository.findById(id);
      if (domain === null) {
        throw new NotFoundError("Domain", id);
      }
      if (domain.verifiedAt !== null) {
        return domain;
      }

      // TXT proves ownership. MX is an independent activation gate because
      // inbound mail cannot reach this deployment when another provider is
      // still authoritative for the domain.
      const recordName = `_mailcal.${domain.name}`;
      const expected = `mailcal-verification=${domain.verificationToken}`;
      let values: readonly string[];
      try {
        values = await deps.dns.lookupTxt(recordName);
      } catch {
        throw new ServiceUnavailableError(
          "DNS lookup failed; try again shortly",
        );
      }
      if (!values.includes(expected)) {
        throw new ConflictError(
          `TXT record ${recordName} with value "${expected}" was not found. ` +
            "Add it at your DNS provider and retry once it has propagated",
        );
      }

      const mxSuffix = deps.instanceConfig.inboundMxSuffix;
      if (mxSuffix !== null) {
        let mxRecords: readonly MxRecord[];
        try {
          mxRecords = await deps.dns.lookupMx(domain.name);
        } catch {
          throw new ServiceUnavailableError(
            "MX lookup failed; try again shortly",
          );
        }
        const mxStatus = classifyInboundMx(mxRecords, mxSuffix);
        if (mxStatus !== InboundMxStatus.Ready) {
          const normalizedSuffix = mxSuffix.toLowerCase().replace(/\.$/, "");
          const currentMx = mxRecords
            .map(({ exchange }) => exchange)
            .join(", ");
          throw new ConflictError(
            `MX records for ${domain.name} do not point to Cloudflare Email Routing ` +
              `(*.${normalizedSuffix}); enable Email Routing for the zone ` +
              `(mise run mail-routing-enable ${domain.name}) and retry. ` +
              `Current MX: ${currentMx.length > 0 ? currentMx : "none"}`,
          );
        }
      }

      const verified = verifyMailDomain(domain, deps.clock.now().toISOString());
      await deps.mailDomainRepository.save(verified);
      return verified;
    });
}

export function createSetDomainStatusUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: DomainId, status: DomainStatus) => Promise<MailDomain> {
  return async (viewer, id, status) =>
    withAsyncDomainErrorTranslation(async () => {
      requireGlobalCapability(viewer, Capability.DomainAdmin);
      const domain = await deps.mailDomainRepository.findById(id);
      if (domain === null) {
        throw new NotFoundError("Domain", id);
      }
      const updated = setMailDomainStatus(
        domain,
        status,
        deps.clock.now().toISOString(),
      );
      await deps.mailDomainRepository.save(updated);
      return updated;
    });
}

/** Refuses while the domain still holds mail: deleting it would orphan
 * every stored message and its blobs. Disable it instead -- that stops
 * delivery without destroying history. */
export function createDeleteDomainUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: DomainId) => Promise<boolean> {
  return async (viewer, id) =>
    withAsyncDomainErrorTranslation(async () => {
      requireGlobalCapability(viewer, Capability.DomainAdmin);
      const domain = await deps.mailDomainRepository.findById(id);
      if (domain === null) {
        throw new NotFoundError("Domain", id);
      }
      const messageCount = await deps.mailDomainRepository.countMessages(id);
      if (messageCount > 0) {
        throw new ConflictError(
          `Domain ${domain.name} still has ${messageCount} message(s); disable it instead of deleting it`,
        );
      }
      await deps.mailDomainRepository.delete(id);
      return true;
    });
}

export { DomainStatus };
