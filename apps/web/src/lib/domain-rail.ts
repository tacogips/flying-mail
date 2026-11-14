import type { InboundMxStatus, MailDomainView } from "../api/schema-types";

const INBOUND_MX_LABELS: Readonly<Record<InboundMxStatus, string>> = {
  READY: "MX ready",
  NOT_CLOUDFLARE: "MX not on Cloudflare",
  NONE: "No MX records",
  UNKNOWN: "MX status unknown",
};

export function inboundMxLabel(status: InboundMxStatus): string {
  return INBOUND_MX_LABELS[status];
}

/** Return active domains that contain at least one address the viewer can read. */
export function readableActiveDomains(
  domains: readonly MailDomainView[],
  readableAddresses: readonly string[],
): readonly MailDomainView[] {
  const readableDomains = new Set(
    readableAddresses.map((address) => addressDomain(address)),
  );
  return domains
    .filter(
      (domain) =>
        domain.status === "ACTIVE" &&
        readableDomains.has(domain.name.toLowerCase()),
    )
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function addressDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

export function addressMatchesPattern(
  pattern: string,
  address: string,
): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", "[^@]*");
  return new RegExp(`^${escaped}$`, "i").test(address);
}

/** Two initials from the first DNS label, preserving Unicode code points. */
export function domainInitials(domainName: string): string {
  const label = domainName.split(".")[0]?.trim() ?? "";
  return Array.from(label).slice(0, 2).join("").toUpperCase() || "?";
}

export function activeSendableAddresses(
  sendableAddresses: readonly string[],
  domains: readonly MailDomainView[],
): readonly string[] {
  const activeNames = new Set(
    domains
      .filter((domain) => domain.status === "ACTIVE")
      .map((domain) => domain.name.toLowerCase()),
  );
  return sendableAddresses.filter((address) =>
    activeNames.has(addressDomain(address)),
  );
}

export function defaultFromForScope(
  sendableAddresses: readonly string[],
  domains: readonly MailDomainView[],
  scope: { readonly domainId?: string; readonly address?: string },
): string {
  const activeAddresses = activeSendableAddresses(sendableAddresses, domains);
  if (scope.address !== undefined) {
    const scopedAddress = scope.address;
    if (activeAddresses.includes(scopedAddress)) return scopedAddress;
    if (
      activeAddresses.some(
        (address) =>
          address.includes("*") &&
          addressMatchesPattern(address, scopedAddress),
      )
    ) {
      return scopedAddress;
    }
  }
  if (scope.domainId !== undefined) {
    const domain = domains.find(
      (entry) => entry.id === scope.domainId && entry.status === "ACTIVE",
    );
    if (domain !== undefined) {
      const scopedAddress = activeAddresses.find(
        (address) =>
          !address.includes("*") &&
          addressDomain(address) === domain.name.toLowerCase(),
      );
      if (scopedAddress !== undefined) return scopedAddress;
      const concreteAddress = activeAddresses.find(
        (address) => !address.includes("*"),
      );
      if (concreteAddress !== undefined) return concreteAddress;
      const scopedPattern = activeAddresses.find(
        (address) =>
          address.includes("*") &&
          addressDomain(address) === domain.name.toLowerCase(),
      );
      if (scopedPattern !== undefined) return scopedPattern;
    }
  }
  return (
    activeAddresses.find((address) => !address.includes("*")) ??
    activeAddresses[0] ??
    ""
  );
}
