import { Capability } from "@mailcal/domain/entities/api-key";
import {
  createMailDomain,
  DomainStatus,
  type MailDomain,
  setMailDomainStatus,
  verifyMailDomain,
} from "@mailcal/domain/entities/mail-domain";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import {
  createDomainId,
  type DomainId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
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

export interface DnsRecord {
  readonly type: "TXT" | "MX" | "CNAME";
  readonly name: string;
  readonly value: string;
  readonly priority: number | null;
  readonly purpose: string;
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

/** Records the operator's assertion that the DNS records are published.
 *
 * There is deliberately no DNS lookup here: the Workers runtime has no
 * resolver, and adding an outbound HTTP DNS-over-HTTPS call would make
 * domain setup depend on a third party being reachable. Verification is
 * therefore an explicit, audited operator action -- and the ingest path
 * still refuses mail for a domain whose MX records do not actually point
 * here, because that mail simply never arrives. */
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

      // Ownership is proven by the TXT record and nothing less: a verify
      // that rubber-stamps would let anyone claim a domain they cannot
      // touch. MX correctness is deliberately not checked here -- mail
      // for a domain with wrong MX simply never arrives, while a wrong
      // ownership claim is a security problem.
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
