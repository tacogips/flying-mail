import { createSignal, type JSX } from "solid-js";
import type { MailboxView } from "../lib/filter-params";
import { render } from "solid-js/web";
import { describe, expect, test, vi } from "vitest";
import type { MailDomainView } from "../api/schema-types";
import {
  activeSendableAddresses,
  defaultFromForScope,
  domainInitials,
  inboundMxLabel,
  readableActiveDomains,
} from "../lib/domain-rail";
import { fullSearchParamsForView } from "../lib/filter-params";
import { DomainRail } from "./domain-rail";
import { MailboxSidebar } from "./mailbox-sidebar";
import { StoreProvider } from "../store/store-context";

const domains: readonly MailDomainView[] = [
  {
    id: "active-1",
    name: "alpha.example",
    status: "ACTIVE",
    inboundMx: "READY",
    catchAll: true,
    verificationToken: null,
    verifiedAt: "2026-10-01T00:00:00.000Z",
    messageCount: 7,
    dnsRecords: [],
  },
  {
    id: "active-2",
    name: "beta.example",
    status: "ACTIVE",
    inboundMx: "READY",
    catchAll: false,
    verificationToken: null,
    verifiedAt: "2026-10-01T00:00:00.000Z",
    messageCount: 2,
    dnsRecords: [],
  },
  {
    id: "pending-1",
    name: "waiting.example",
    status: "PENDING",
    inboundMx: "NONE",
    catchAll: true,
    verificationToken: "token",
    verifiedAt: null,
    messageCount: 0,
    dnsRecords: [],
  },
  {
    id: "disabled-1",
    name: "paused.example",
    status: "DISABLED",
    inboundMx: "READY",
    catchAll: false,
    verificationToken: null,
    verifiedAt: "2026-10-01T00:00:00.000Z",
    messageCount: 3,
    dnsRecords: [],
  },
];

function mount(node: () => JSX.Element): {
  element: HTMLElement;
  dispose: () => void;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = render(() => node(), container);
  return {
    element: container,
    dispose: () => {
      dispose();
      container.remove();
    },
  };
}

describe("domain rail and mailbox scoping", () => {
  test("shows All and readable ACTIVE domains with initials, stable colors, selection, badges, and admin settings", () => {
    const onSelectDomain = vi.fn();
    const mounted = mount(() => (
      <DomainRail
        domains={domains}
        readableAddresses={[
          "ada@alpha.example",
          "team@beta.example",
          "x@waiting.example",
          "ops@paused.example",
        ]}
        selectedDomainId="active-1"
        allUnread={4}
        unreadByDomain={{ "active-1": 2 }}
        isAdmin
        onSelectDomain={onSelectDomain}
      />
    ));
    const alpha = mounted.element.querySelector<HTMLButtonElement>(
      'button[aria-label^="alpha.example"]',
    );
    expect(alpha?.title).toBe("alpha.example");
    expect(alpha?.getAttribute("aria-label")).toBe("alpha.example, 2 unread");
    expect(alpha?.getAttribute("aria-current")).toBe("page");
    expect(alpha?.className).toContain("domain-rail-item-selected");
    expect(alpha?.textContent).toContain("AL");
    expect(alpha?.querySelector(".domain-rail-avatar")?.className).toContain(
      "avatar-c",
    );
    expect(alpha?.querySelector(".domain-rail-badge")?.textContent).toBe("2");
    expect(
      mounted.element.querySelector('[aria-label^="waiting.example"]'),
    ).toBeNull();
    expect(
      mounted.element.querySelector('[aria-label^="paused.example"]'),
    ).toBeNull();
    expect(
      mounted.element
        .querySelector('[aria-label="Domain settings"]')
        ?.getAttribute("href"),
    ).toBe("/settings/domains");
    const all = mounted.element.querySelector<HTMLButtonElement>(
      'button[aria-label="All mail"]',
    );
    expect(all?.querySelector(".domain-rail-badge")?.textContent).toBe("4");
    all?.click();
    expect(onSelectDomain).toHaveBeenCalledWith(undefined);
    mounted.dispose();
  });

  test("keeps All and domain address scopes URL-serializable and excludes inactive domains", () => {
    expect(
      readableActiveDomains(domains, [
        "x@waiting.example",
        "ops@paused.example",
      ]).map(({ id }) => id),
    ).toEqual([]);
    expect(
      activeSendableAddresses(
        [
          "ada@alpha.example",
          "team@beta.example",
          "x@waiting.example",
          "ops@paused.example",
        ],
        domains,
      ),
    ).toEqual(["ada@alpha.example", "team@beta.example"]);
    expect(domainInitials("école.example")).toBe("ÉC");
    expect(
      fullSearchParamsForView({
        folder: { kind: "INBOX" },
        scope: { domainId: "active-1", address: "ada@alpha.example" },
      }),
    ).toMatchObject({
      view: "INBOX",
      domain: "active-1",
      address: "ada@alpha.example",
    });
    expect(
      defaultFromForScope(
        [
          "first@beta.example",
          "ada@alpha.example",
          "*@waiting.example",
          "*@paused.example",
        ],
        domains,
        { domainId: "active-1", address: "ada@alpha.example" },
      ),
    ).toBe("ada@alpha.example");
    expect(
      defaultFromForScope(["*@alpha.example", "*@beta.example"], domains, {
        domainId: "active-1",
        address: "info@alpha.example",
      }),
    ).toBe("info@alpha.example");
    expect(
      defaultFromForScope(["*@alpha.example", "info@beta.example"], domains, {
        domainId: "active-1",
      }),
    ).toBe("info@beta.example");
    expect(inboundMxLabel("READY")).toBe("MX ready");
    expect(inboundMxLabel("NOT_CLOUDFLARE")).toBe("MX not on Cloudflare");
    expect(inboundMxLabel("NONE")).toBe("No MX records");
    expect(inboundMxLabel("UNKNOWN")).toBe("MX status unknown");
    expect(
      defaultFromForScope(
        [
          "first@beta.example",
          "ada@alpha.example",
          "*@waiting.example",
          "*@paused.example",
        ],
        domains,
        { domainId: "active-2" },
      ),
    ).toBe("first@beta.example");
    expect(
      defaultFromForScope(
        ["*@waiting.example", "*@paused.example", "ada@alpha.example"],
        domains,
        {},
      ),
    ).toBe("ada@alpha.example");
  });

  test("shows selected-domain addresses and grouped All addresses without a Domains section", () => {
    const onSelectScope = vi.fn();
    const selected = mount(() => (
      <StoreProvider>
        <MailboxSidebar
          current={{
            folder: { kind: "INBOX" },
            scope: { domainId: "active-1" },
          }}
          domains={domains}
          readableAddresses={[
            "ada@alpha.example",
            "team@beta.example",
            "x@waiting.example",
            "ops@paused.example",
          ]}
          addressActivity={[
            {
              address: "ada@alpha.example",
              domainId: "active-1",
              lastActivityAt: "2026-10-06T00:00:00.000Z",
              unreadCount: 3,
            },
            {
              address: "team@beta.example",
              domainId: "active-2",
              lastActivityAt: null,
              unreadCount: 0,
            },
          ]}
          tags={[]}
          upcomingEvents={[]}
          inboxUnread={0}
          onSelect={() => undefined}
          onSelectScope={onSelectScope}
          onCompose={() => undefined}
          onOpenEvent={() => undefined}
        />
      </StoreProvider>
    ));
    expect(
      selected.element.querySelector(".sidebar-domain-heading")?.textContent,
    ).toBe("alpha.example");
    expect(selected.element.textContent).toContain("ADDRESSES");
    expect(selected.element.textContent).toContain("ada@alpha.example");
    expect(selected.element.textContent).toContain("3");
    const selectedAddress = selected.element.querySelector<HTMLButtonElement>(
      ".sidebar-address-list button",
    );
    expect(selectedAddress?.title).toBe("ada@alpha.example");
    expect(
      selectedAddress?.querySelector(".sidebar-address-local-part")
        ?.textContent,
    ).toBe("ada");
    expect(
      selectedAddress?.querySelector(".sidebar-address-domain-part")
        ?.textContent,
    ).toBe("@alpha.example");
    expect(
      selectedAddress?.querySelector(".sidebar-address-domain-hint"),
    ).toBeNull();
    expect(selectedAddress?.querySelector(".sidebar-badge")?.textContent).toBe(
      "3",
    );
    expect(
      selected.element.querySelector(".sidebar-heading")?.textContent,
    ).toBe("ADDRESSES");
    expect(selected.element.textContent).not.toContain("team@beta.example");
    expect(selected.element.textContent).not.toContain("waiting.example");
    expect(selected.element.textContent).not.toContain("paused.example");
    expect(selected.element.textContent).not.toContain("Domains");
    selectedAddress?.click();
    expect(onSelectScope).toHaveBeenCalledWith({
      domainId: "active-1",
      address: "ada@alpha.example",
    });
    selected.dispose();

    const all = mount(() => (
      <StoreProvider>
        <MailboxSidebar
          current={{ folder: { kind: "INBOX" }, scope: {} }}
          domains={domains}
          readableAddresses={[
            "ada@alpha.example",
            "team@beta.example",
            "x@waiting.example",
            "ops@paused.example",
          ]}
          addressActivity={[
            {
              address: "ada@alpha.example",
              domainId: "active-1",
              lastActivityAt: "2026-10-06T00:00:00.000Z",
              unreadCount: 3,
            },
            {
              address: "team@beta.example",
              domainId: "active-2",
              lastActivityAt: null,
              unreadCount: 0,
            },
          ]}
          tags={[]}
          upcomingEvents={[]}
          inboxUnread={0}
          onSelect={() => undefined}
          onSelectScope={onSelectScope}
          onCompose={() => undefined}
          onOpenEvent={() => undefined}
        />
      </StoreProvider>
    ));
    expect(
      all.element.querySelector(".sidebar-domain-heading")?.textContent,
    ).toBe("All mail");
    expect(all.element.textContent).toContain("alpha.example");
    expect(all.element.textContent).toContain("beta.example");
    const allAddressButtons = Array.from(
      all.element.querySelectorAll<HTMLButtonElement>(
        ".sidebar-address-list button",
      ),
    );
    expect(
      allAddressButtons.map((button) => ({
        title: button.title,
        localPart: button.querySelector(".sidebar-address-local-part")
          ?.textContent,
        domainPart: button.querySelector(".sidebar-address-domain-part")
          ?.textContent,
      })),
    ).toEqual([
      {
        title: "ada@alpha.example",
        localPart: "ada",
        domainPart: "@alpha.example",
      },
      {
        title: "team@beta.example",
        localPart: "team",
        domainPart: "@beta.example",
      },
    ]);
    expect(
      all.element.querySelector(".sidebar-address-domain-hint"),
    ).toBeNull();
    expect(all.element.textContent).not.toContain("waiting.example");
    expect(all.element.textContent).not.toContain("paused.example");
    const allMail = Array.from(all.element.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("All mail"),
    );
    allMail?.click();
    expect(onSelectScope).toHaveBeenCalledWith({});
    all.dispose();
  });

  test("shows the top seven, keeps the selected address, expands, and filters all addresses", () => {
    const addresses = Array.from(
      { length: 9 },
      (_, index) => `user${index}@alpha.example`,
    );
    const selectedAddress = addresses.at(-1);
    if (selectedAddress === undefined) {
      throw new Error("expected seeded addresses");
    }
    const activities = addresses.map((address, index) => ({
      address,
      domainId: "active-1",
      lastActivityAt: `2026-10-${String(9 - index).padStart(2, "0")}T00:00:00.000Z`,
      unreadCount: index === 0 ? 2 : 0,
    }));
    const mounted = mount(() => (
      <StoreProvider>
        <MailboxSidebar
          current={{
            folder: { kind: "INBOX" },
            scope: { domainId: "active-1", address: selectedAddress },
          }}
          domains={domains}
          readableAddresses={addresses}
          addressActivity={activities}
          tags={[]}
          upcomingEvents={[]}
          inboxUnread={0}
          onSelect={() => undefined}
          onSelectScope={() => undefined}
          onCompose={() => undefined}
          onOpenEvent={() => undefined}
        />
      </StoreProvider>
    ));
    const list = mounted.element.querySelector(".sidebar-address-list");
    expect(list?.querySelectorAll("button")).toHaveLength(8);
    expect(list?.textContent).toContain(selectedAddress);
    expect(list?.textContent).toContain("2");

    const expand = Array.from(mounted.element.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Show all (9)"),
    );
    expand?.click();
    expect(list?.querySelectorAll("button")).toHaveLength(9);
    Array.from(mounted.element.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Show fewer"))
      ?.click();

    const filter = mounted.element.querySelector<HTMLInputElement>(
      'input[aria-label="Filter addresses"]',
    );
    if (filter === null) {
      throw new Error("address filter is missing");
    }
    filter.value = "USER4";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    expect(list?.textContent).toContain("user4@alpha.example");
    expect(list?.textContent).not.toContain("user3@alpha.example");
    expect(
      Array.from(mounted.element.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Show all"),
      )?.textContent,
    ).toBe("Show all (1)");
    mounted.dispose();
  });

  test("clears a filter when switching to a scope that hides the filter input", () => {
    const [current, setCurrent] = createSignal<MailboxView>({
      folder: { kind: "INBOX" as const },
      scope: {},
    });
    const addresses = [
      ...Array.from({ length: 9 }, (_, index) => `user${index}@alpha.example`),
      "one@beta.example",
      "two@beta.example",
    ];
    const addressActivity = addresses.map((address, index) => ({
      address,
      domainId: index < 9 ? "active-1" : "active-2",
      lastActivityAt: `2026-10-${String(20 - index).padStart(2, "0")}T00:00:00.000Z`,
      unreadCount: 0,
    }));
    const mounted = mount(() => (
      <StoreProvider>
        <MailboxSidebar
          current={current()}
          domains={domains}
          readableAddresses={addresses}
          addressActivity={addressActivity}
          tags={[]}
          upcomingEvents={[]}
          inboxUnread={0}
          onSelect={() => undefined}
          onSelectScope={() => undefined}
          onCompose={() => undefined}
          onOpenEvent={() => undefined}
        />
      </StoreProvider>
    ));
    const filter = mounted.element.querySelector<HTMLInputElement>(
      'input[aria-label="Filter addresses"]',
    );
    if (filter === null) {
      throw new Error("address filter is missing");
    }
    filter.value = "does-not-match";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    expect(
      mounted.element.querySelectorAll(".sidebar-address-list button"),
    ).toHaveLength(0);

    setCurrent({ folder: { kind: "INBOX" }, scope: { domainId: "active-2" } });

    expect(
      mounted.element.querySelector('input[aria-label="Filter addresses"]'),
    ).toBeNull();
    expect(
      Array.from(
        mounted.element.querySelectorAll(".sidebar-address-list button"),
      ).map(
        (button) => button.querySelector(".sidebar-item-label")?.textContent,
      ),
    ).toEqual(["one@beta.example", "two@beta.example"]);
    mounted.dispose();
  });
});
