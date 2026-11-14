import { render } from "solid-js/web";
import { afterEach, describe, expect, test, vi } from "vitest";
import { USER_ADMIN_DESCRIPTION } from "../../lib/scope-format";
import type { AppStore } from "../../store/app-store";
import { StoreProvider } from "../../store/store-context";
import ApiKeysPage from "./api-keys-page";

interface RequestBody {
  readonly query: string;
  readonly variables?: Record<string, unknown>;
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mountApiKeys() {
  const store = {
    domains: () => [],
    loadReferenceData: async () => undefined,
  } as unknown as AppStore;
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = render(
    () => (
      <StoreProvider store={store}>
        <ApiKeysPage />
      </StoreProvider>
    ),
    container,
  );
  return { container, dispose };
}

function selectCapability(container: HTMLElement, capability: string): void {
  const select = container.querySelector<HTMLSelectElement>(
    '[aria-label="Capability"]',
  );
  if (select === null) {
    throw new Error("Capability select not found");
  }
  select.value = capability;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API key USER_ADMIN scope", () => {
  test("shows the description and hides scope inputs only for USER_ADMIN", async () => {
    vi.stubGlobal("fetch", async () => response({ data: { apiKeys: [] } }));
    const { container, dispose } = mountApiKeys();
    await flush();

    const userAdminOption = container.querySelector<HTMLOptionElement>(
      'option[value="USER_ADMIN"]',
    );
    expect(userAdminOption?.textContent).toBe(
      "Administer users (roles, activation, permission rules)",
    );
    expect(container.querySelector('[aria-label="Domain"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Address pattern"]')).not.toBe(
      null,
    );

    selectCapability(container, "USER_ADMIN");
    await flush();
    expect(container.textContent).toContain(USER_ADMIN_DESCRIPTION);
    const capabilitySelect = container.querySelector<HTMLSelectElement>(
      '[aria-label="Capability"]',
    );
    expect(capabilitySelect?.getAttribute("aria-describedby")).toBe(
      "user-admin-desc-0",
    );
    expect(container.querySelector("#user-admin-desc-0")?.textContent).toBe(
      USER_ADMIN_DESCRIPTION,
    );
    expect(container.querySelector('[aria-label="Domain"]')).toBeNull();
    expect(
      container.querySelector('[aria-label="Address pattern"]'),
    ).toBeNull();

    selectCapability(container, "MAIL_READ");
    await flush();
    expect(container.textContent).not.toContain(USER_ADMIN_DESCRIPTION);
    const mailReadCapabilitySelect = container.querySelector<HTMLSelectElement>(
      '[aria-label="Capability"]',
    );
    expect(
      mailReadCapabilitySelect?.getAttribute("aria-describedby"),
    ).toBeNull();
    expect(container.querySelector('[aria-label="Domain"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Address pattern"]')).not.toBe(
      null,
    );

    dispose();
    container.remove();
  });

  test("submits USER_ADMIN through the instance-wide scope path", async () => {
    const calls: RequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      async (_url: RequestInfo | URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as RequestBody;
        calls.push(body);
        if (body.query.includes("mutation CreateApiKey")) {
          return response({
            data: {
              createApiKey: {
                secret: "secret-once",
                apiKey: {
                  id: "key-1",
                  name: "user admin",
                  keyPrefix: "fm_test",
                  createdAt: "2026-01-01T00:00:00Z",
                  lastUsedAt: null,
                  expiresAt: null,
                  revokedAt: null,
                  scopes: [],
                },
              },
            },
          });
        }
        return response({ data: { apiKeys: [] } });
      },
    );
    const { container, dispose } = mountApiKeys();
    await flush();
    selectCapability(container, "USER_ADMIN");
    const name = container.querySelector<HTMLInputElement>("#key-name");
    if (name === null) {
      throw new Error("Key name input not found");
    }
    name.value = "user admin";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    const form = container.querySelector("form");
    if (form === null) {
      throw new Error("Key form not found");
    }
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();

    const createCall = calls.find((call) =>
      call.query.includes("mutation CreateApiKey"),
    );
    expect(createCall?.variables).toEqual({
      input: {
        name: "user admin",
        scopes: [
          {
            capability: "USER_ADMIN",
            domainId: null,
            addressPattern: "*",
          },
        ],
      },
    });

    dispose();
    container.remove();
  });
});
