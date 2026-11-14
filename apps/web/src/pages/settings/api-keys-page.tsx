import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import {
  API_KEYS_QUERY,
  CREATE_API_KEY_MUTATION,
  REVOKE_API_KEY_MUTATION,
} from "../../api/documents";
import { graphqlRequest } from "../../api/graphql-client";
import type { ApiKeyView, Capability } from "../../api/schema-types";
import {
  CAPABILITY_LABELS,
  formatScope,
  isGlobalCapability,
  isValidAddressPattern,
} from "../../lib/scope-format";
import { describeErrors } from "../../lib/mutation-error";
import { pushToast } from "../../lib/toast";
import { useStore } from "../../store/store-context";
import "./settings.css";

interface ScopeRow {
  readonly capability: Capability;
  readonly domainId: string | null;
  readonly addressPattern: string;
}

const ALL_CAPABILITIES = Object.keys(CAPABILITY_LABELS) as Capability[];

const EMPTY_ROW: ScopeRow = {
  capability: "MAIL_READ",
  domainId: null,
  addressPattern: "*",
};

export default function ApiKeysPage(): JSX.Element {
  const store = useStore();
  const [keys, setKeys] = createSignal<readonly ApiKeyView[]>([]);
  const [name, setName] = createSignal("");
  const [rows, setRows] = createSignal<readonly ScopeRow[]>([EMPTY_ROW]);
  const [secret, setSecret] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  async function reload(): Promise<void> {
    const result = await graphqlRequest<{
      readonly apiKeys: readonly ApiKeyView[];
    }>(API_KEYS_QUERY);
    if (result.ok) {
      setKeys(result.data.apiKeys);
    } else {
      pushToast("error", describeErrors(result.errors));
    }
  }

  onMount(() => {
    void reload();
    void store.loadReferenceData();
  });

  function updateRow(index: number, patch: Partial<ScopeRow>): void {
    setRows((current) =>
      current.map((row, position) =>
        position === index ? { ...row, ...patch } : row,
      ),
    );
  }

  async function createKey(event: Event): Promise<void> {
    event.preventDefault();
    const scopes = rows();
    if (scopes.length === 0) {
      pushToast("error", "A key must be issued with at least one scope");
      return;
    }
    // Validated client-side with the same grammar the server enforces, so a
    // typo is caught before a key is issued rather than after.
    const invalid = scopes.find(
      (row) =>
        !isGlobalCapability(row.capability) &&
        !isValidAddressPattern(row.addressPattern),
    );
    if (invalid !== undefined) {
      pushToast(
        "error",
        `"${invalid.addressPattern}" is not a valid address pattern`,
      );
      return;
    }

    setBusy(true);
    const result = await graphqlRequest<
      {
        readonly createApiKey: {
          readonly secret: string;
          readonly apiKey: ApiKeyView;
        };
      },
      Record<string, unknown>
    >(CREATE_API_KEY_MUTATION, {
      input: {
        name: name(),
        scopes: scopes.map((row) => ({
          capability: row.capability,
          domainId: isGlobalCapability(row.capability) ? null : row.domainId,
          addressPattern: isGlobalCapability(row.capability)
            ? "*"
            : row.addressPattern,
        })),
      },
    });
    setBusy(false);
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    // Held in a signal only, never persisted: this is the one and only time
    // the plaintext exists outside the caller's hands.
    setSecret(result.data.createApiKey.secret);
    setName("");
    setRows([EMPTY_ROW]);
    await reload();
  }

  async function revoke(id: string): Promise<void> {
    const result = await graphqlRequest<
      { readonly revokeApiKey: { readonly id: string } },
      Record<string, unknown>
    >(REVOKE_API_KEY_MUTATION, { id });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    pushToast("success", "Key revoked");
    await reload();
  }

  return (
    <div class="settings-page">
      <h1>API keys</h1>

      <Show when={secret() !== null}>
        <div class="panel secret-reveal">
          <strong>Copy this key now. It will not be shown again.</strong>
          <code class="secret-value">{secret()}</code>
          <div class="row">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(secret() ?? "");
                pushToast("success", "Key copied");
              }}
            >
              Copy
            </button>
            <button type="button" onClick={() => setSecret(null)}>
              I have saved it
            </button>
          </div>
        </div>
      </Show>

      <form class="panel" onSubmit={(event) => void createKey(event)}>
        <h2>Issue a key</h2>
        <div class="field">
          <label for="key-name">Name</label>
          <input
            id="key-name"
            type="text"
            required
            placeholder="support agent"
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </div>

        <h3>Scopes</h3>
        <p class="muted">
          A key can do only what its scopes allow. An unscoped key is rejected.
        </p>
        <For each={rows()}>
          {(row, index) => (
            <div class="scope-row">
              <select
                aria-label="Capability"
                value={row.capability}
                onChange={(event) =>
                  updateRow(index(), {
                    capability: event.currentTarget.value as Capability,
                  })
                }
              >
                <For each={ALL_CAPABILITIES}>
                  {(capability) => (
                    <option value={capability}>
                      {CAPABILITY_LABELS[capability]}
                    </option>
                  )}
                </For>
              </select>

              <Show when={!isGlobalCapability(row.capability)}>
                <select
                  aria-label="Domain"
                  value={row.domainId ?? ""}
                  onChange={(event) =>
                    updateRow(index(), {
                      domainId:
                        event.currentTarget.value === ""
                          ? null
                          : event.currentTarget.value,
                    })
                  }
                >
                  <option value="">Every managed domain</option>
                  <For each={store.domains()}>
                    {(domain) => (
                      <option value={domain.id}>{domain.name}</option>
                    )}
                  </For>
                </select>

                <input
                  type="text"
                  aria-label="Address pattern"
                  placeholder="*  |  *@example.com  |  support@example.com"
                  value={row.addressPattern}
                  onInput={(event) =>
                    updateRow(index(), {
                      addressPattern: event.currentTarget.value,
                    })
                  }
                />
              </Show>

              <button
                type="button"
                class="danger"
                aria-label="Remove scope"
                onClick={() =>
                  setRows((current) =>
                    current.filter((_row, position) => position !== index()),
                  )
                }
              >
                Remove
              </button>
            </div>
          )}
        </For>

        <div class="row">
          <button
            type="button"
            onClick={() => setRows((current) => [...current, EMPTY_ROW])}
          >
            Add scope
          </button>
          <button type="submit" class="primary" disabled={busy()}>
            {busy() ? "Issuing..." : "Issue key"}
          </button>
        </div>
      </form>

      <div class="panel">
        <h2>Existing keys</h2>
        <Show
          when={keys().length > 0}
          fallback={<p class="muted">No keys have been issued.</p>}
        >
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Scopes</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <For each={keys()}>
                {(key) => (
                  <tr classList={{ revoked: key.revokedAt !== null }}>
                    <td>{key.name}</td>
                    <td>
                      <code>{key.keyPrefix}</code>
                    </td>
                    <td>
                      <ul class="scope-list">
                        <For each={key.scopes}>
                          {(scope) => <li>{formatScope(scope)}</li>}
                        </For>
                      </ul>
                    </td>
                    <td class="muted">{key.lastUsedAt ?? "never"}</td>
                    <td>
                      <Show
                        when={key.revokedAt === null}
                        fallback={<span class="muted">revoked</span>}
                      >
                        <button
                          type="button"
                          class="danger"
                          onClick={() => void revoke(key.id)}
                        >
                          Revoke
                        </button>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </div>

      <a href="/">Back to mail</a>
    </div>
  );
}
