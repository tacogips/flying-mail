import { For, type JSX, Show } from "solid-js";
import type { MailDomainView } from "../api/schema-types";
import {
  addressDomain,
  domainInitials,
  readableActiveDomains,
} from "../lib/domain-rail";
import { avatarClass } from "../lib/avatar";
import { GearIcon } from "./icons";
import "./domain-rail.css";

export function DomainRail(props: {
  readonly domains: readonly MailDomainView[];
  readonly readableAddresses: readonly string[];
  readonly selectedDomainId: string | undefined;
  readonly allUnread: number;
  readonly unreadByDomain: Readonly<Record<string, number>>;
  readonly isAdmin: boolean;
  readonly onSelectDomain: (domainId: string | undefined) => void;
}): JSX.Element {
  const activeDomains = () =>
    readableActiveDomains(props.domains, props.readableAddresses);
  const isSelected = (domainId: string | undefined): boolean =>
    props.selectedDomainId === domainId;
  const unreadForDomain = (domain: MailDomainView): number =>
    props.unreadByDomain[domain.id] ?? 0;

  return (
    <nav class="domain-rail" aria-label="Mail domains">
      <button
        type="button"
        classList={{
          "domain-rail-item": true,
          "domain-rail-item-selected": isSelected(undefined),
        }}
        aria-label="All mail"
        aria-current={isSelected(undefined) ? "page" : undefined}
        title="All mail"
        onClick={() => props.onSelectDomain(undefined)}
      >
        <span class="domain-rail-avatar domain-rail-all">All</span>
        <Show when={props.allUnread > 0}>
          <span class="domain-rail-badge">{props.allUnread}</span>
        </Show>
      </button>

      <For each={activeDomains()}>
        {(domain) => {
          const selected = () => isSelected(domain.id);
          const unread = () => unreadForDomain(domain);
          return (
            <button
              type="button"
              classList={{
                "domain-rail-item": true,
                "domain-rail-item-selected": selected(),
              }}
              aria-label={`${domain.name}, ${unread()} unread`}
              aria-current={selected() ? "page" : undefined}
              title={domain.name}
              onClick={() => props.onSelectDomain(domain.id)}
            >
              <span class={`domain-rail-avatar ${avatarClass(domain.name)}`}>
                {domainInitials(domain.name)}
              </span>
              <Show when={unread() > 0}>
                <span class="domain-rail-badge">{unread()}</span>
              </Show>
            </button>
          );
        }}
      </For>

      <Show when={props.isAdmin}>
        <a
          class="domain-rail-settings"
          href="/settings/domains"
          aria-label="Domain settings"
          title="Domain settings"
        >
          <GearIcon size={18} />
        </a>
      </Show>
    </nav>
  );
}

export function domainForAddress(
  address: string,
  domains: readonly MailDomainView[],
): MailDomainView | undefined {
  const name = addressDomain(address);
  return domains.find((domain) => domain.name.toLowerCase() === name);
}
