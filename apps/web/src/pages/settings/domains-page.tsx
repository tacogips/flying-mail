import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import {
  CREATE_DOMAIN_MUTATION,
  CREATE_MAIL_ADDRESS_MUTATION,
  DELETE_MAIL_ADDRESS_MUTATION,
  MAIL_ADDRESSES_QUERY,
  SET_DOMAIN_STATUS_MUTATION,
  SET_MAIL_ADDRESS_STATUS_MUTATION,
  VERIFY_DOMAIN_MUTATION,
} from "../../api/documents";
import { graphqlRequest } from "../../api/graphql-client";
import type {
  DomainStatus,
  MailAddressStatus,
  MailAddressView,
  MailDomainView,
} from "../../api/schema-types";
import { describeErrors } from "../../lib/mutation-error";
import { pushToast } from "../../lib/toast";
import { useStore } from "../../store/store-context";
import "./settings.css";

export default function DomainsPage(): JSX.Element {
  const store = useStore();
  const [name, setName] = createSignal("");
  const [catchAll, setCatchAll] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [expanded, setExpanded] = createSignal<string | null>(null);
  const [addresses, setAddresses] = createSignal<readonly MailAddressView[]>(
    [],
  );
  const [newLocalPart, setNewLocalPart] = createSignal<
    Readonly<Record<string, string>>
  >({});

  onMount(() => {
    void store.loadReferenceData();
    void reloadAddresses();
  });

  /** Mailboxes are loaded once for every domain and grouped client-side:
   * the list is small, and one request keeps each domain card from firing
   * its own. */
  async function reloadAddresses(): Promise<void> {
    const result = await graphqlRequest<{
      readonly mailAddresses: readonly MailAddressView[];
    }>(MAIL_ADDRESSES_QUERY);
    if (result.ok) {
      setAddresses(result.data.mailAddresses);
    }
  }

  const addressesFor = (domainId: string): readonly MailAddressView[] =>
    addresses().filter((entry) => entry.domain.id === domainId);

  async function addAddress(domainId: string): Promise<void> {
    const localPart = (newLocalPart()[domainId] ?? "").trim();
    if (localPart.length === 0) {
      return;
    }
    const result = await graphqlRequest<
      { readonly createMailAddress: MailAddressView },
      Record<string, unknown>
    >(CREATE_MAIL_ADDRESS_MUTATION, {
      input: { domainId, localPart, displayName: null },
    });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    setNewLocalPart((current) => ({ ...current, [domainId]: "" }));
    pushToast("success", `${result.data.createMailAddress.address} created`);
    await reloadAddresses();
  }

  async function setAddressStatus(
    id: string,
    status: MailAddressStatus,
  ): Promise<void> {
    const result = await graphqlRequest<unknown, Record<string, unknown>>(
      SET_MAIL_ADDRESS_STATUS_MUTATION,
      { id, status },
    );
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    await reloadAddresses();
  }

  async function removeAddress(address: MailAddressView): Promise<void> {
    const result = await graphqlRequest<unknown, Record<string, unknown>>(
      DELETE_MAIL_ADDRESS_MUTATION,
      { id: address.id },
    );
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    await reloadAddresses();
  }

  async function addDomain(event: Event): Promise<void> {
    event.preventDefault();
    setBusy(true);
    const result = await graphqlRequest<
      { readonly createDomain: MailDomainView },
      Record<string, unknown>
    >(CREATE_DOMAIN_MUTATION, { name: name(), catchAll: catchAll() });
    setBusy(false);
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    setName("");
    setExpanded(result.data.createDomain.id);
    pushToast(
      "info",
      "Domain added. Publish the DNS records below, then verify it.",
    );
    await store.loadReferenceData();
  }

  async function verify(id: string): Promise<void> {
    const result = await graphqlRequest<
      { readonly verifyDomain: { readonly id: string } },
      Record<string, unknown>
    >(VERIFY_DOMAIN_MUTATION, { id });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    pushToast("success", "Domain verified and active");
    await store.loadReferenceData();
  }

  async function setStatus(id: string, status: DomainStatus): Promise<void> {
    const result = await graphqlRequest<
      { readonly setDomainStatus: { readonly id: string } },
      Record<string, unknown>
    >(SET_DOMAIN_STATUS_MUTATION, { id, status });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    await store.loadReferenceData();
  }

  return (
    <div class="settings-page">
      <h1>Domains</h1>

      <form class="panel" onSubmit={(event) => void addDomain(event)}>
        <h2>Add a domain</h2>
        <div class="field">
          <label for="domain-name">Domain name</label>
          <input
            id="domain-name"
            type="text"
            required
            placeholder="example.com"
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </div>
        <div class="field row">
          <input
            id="domain-catchall"
            type="checkbox"
            style={{ width: "auto" }}
            checked={catchAll()}
            onChange={(event) => setCatchAll(event.currentTarget.checked)}
          />
          <label for="domain-catchall" style={{ margin: 0 }}>
            Accept mail for every address on this domain (catch-all)
          </label>
        </div>
        <button type="submit" class="primary" disabled={busy()}>
          Add domain
        </button>
      </form>

      <For each={store.domains()}>
        {(domain) => (
          <div class="panel">
            <h2>
              {domain.name} <span class="muted">({domain.status})</span>
            </h2>
            <p class="muted">
              {domain.messageCount} message(s)
              {domain.catchAll ? ", catch-all" : ", known addresses only"}
            </p>

            <div class="row">
              <Show when={domain.verifiedAt === null}>
                <button type="button" onClick={() => void verify(domain.id)}>
                  I have published the records - verify
                </button>
              </Show>
              <Show when={domain.status === "ACTIVE"}>
                <button
                  type="button"
                  onClick={() => void setStatus(domain.id, "DISABLED")}
                >
                  Disable
                </button>
              </Show>
              <Show when={domain.status === "DISABLED"}>
                <button
                  type="button"
                  onClick={() => void setStatus(domain.id, "ACTIVE")}
                >
                  Enable
                </button>
              </Show>
              <button
                type="button"
                onClick={() =>
                  setExpanded((current) =>
                    current === domain.id ? null : domain.id,
                  )
                }
              >
                {expanded() === domain.id ? "Hide" : "Show"} DNS records
              </button>
            </div>

            <h3>Mailboxes</h3>
            <p class="muted">
              A provisioned mailbox accepts mail even before its first message.
              Disabling one rejects delivery even on a catch-all domain, and
              keeps its history.
            </p>
            <Show
              when={addressesFor(domain.id).length > 0}
              fallback={
                <p class="muted">
                  {domain.catchAll
                    ? "None yet. This domain is catch-all, so every address is accepted."
                    : "None yet. Without a mailbox this domain only accepts addresses it has already seen."}
                </p>
              }
            >
              <ul class="scope-list permission-list">
                <For each={addressesFor(domain.id)}>
                  {(entry) => (
                    <li class="permission-row">
                      <span>
                        <code>{entry.address}</code>
                        <Show when={entry.displayName !== null}>
                          {" "}
                          <span class="muted">{entry.displayName}</span>
                        </Show>
                        <Show when={entry.status === "DISABLED"}>
                          {" "}
                          <span class="muted">(disabled)</span>
                        </Show>
                      </span>
                      <span>
                        <button
                          type="button"
                          onClick={() =>
                            void setAddressStatus(
                              entry.id,
                              entry.status === "ACTIVE" ? "DISABLED" : "ACTIVE",
                            )
                          }
                        >
                          {entry.status === "ACTIVE" ? "Disable" : "Enable"}
                        </button>
                        <button
                          type="button"
                          class="danger"
                          onClick={() => void removeAddress(entry)}
                        >
                          Delete
                        </button>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>

            <form
              class="scope-row"
              onSubmit={(event) => {
                event.preventDefault();
                void addAddress(domain.id);
              }}
            >
              <input
                type="text"
                aria-label={`New mailbox on ${domain.name}`}
                placeholder="support"
                value={newLocalPart()[domain.id] ?? ""}
                onInput={(event) =>
                  setNewLocalPart((current) => ({
                    ...current,
                    [domain.id]: event.currentTarget.value,
                  }))
                }
              />
              <span class="muted">@{domain.name}</span>
              <button type="submit">Add mailbox</button>
            </form>

            <Show when={expanded() === domain.id}>
              <table class="dns-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Name</th>
                    <th>Value</th>
                    <th>Priority</th>
                    <th>Purpose</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={domain.dnsRecords}>
                    {(record) => (
                      <tr>
                        <td>{record.type}</td>
                        <td>
                          <code>{record.name}</code>
                        </td>
                        <td>
                          <code>{record.value}</code>
                        </td>
                        <td>{record.priority ?? ""}</td>
                        <td class="muted">{record.purpose}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
        )}
      </For>

      <a href="/">Back to mail</a>
    </div>
  );
}
