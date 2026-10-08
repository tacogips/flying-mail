import { render } from "solid-js/web";
import { afterEach, describe, expect, test, vi } from "vitest";
import { activeToasts, clearToasts } from "../../lib/toast";
import type { AppStore } from "../../store/app-store";
import { StoreProvider } from "../../store/store-context";
import UsersPage from "./users-page";

interface RequestBody {
  readonly query: string;
  readonly variables?: Record<string, unknown>;
}

function user(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "user-1",
    email: "pending@example.test",
    name: "Pending User",
    role: "MEMBER",
    active: true,
    invitationStatus: "PENDING",
    permissions: [],
    templatePermissions: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mountUsers() {
  const store = {
    domains: () => [],
    loadReferenceData: async () => undefined,
  } as unknown as AppStore;
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = render(
    () => (
      <StoreProvider store={store}>
        <UsersPage />
      </StoreProvider>
    ),
    container,
  );
  return { container, dispose };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe("user invitations", () => {
  test("shows pending status, resends, and surfaces RATE_LIMITED", async () => {
    const calls: RequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      async (_url: RequestInfo | URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as RequestBody;
        calls.push(body);
        if (body.query.includes("query Users")) {
          return response({ data: { users: [user()] } });
        }
        if (body.query.includes("mutation ResendInvitation")) {
          return response({
            errors: [
              {
                message: "Too many requests; try again later",
                extensions: { code: "RATE_LIMITED" },
              },
            ],
          });
        }
        throw new Error(`Unexpected GraphQL request: ${body.query}`);
      },
    );
    const { container, dispose } = mountUsers();
    await flush();
    expect(container.textContent).toContain("Invitation pending");
    expect(container.textContent).toContain("Invite user");
    const resend = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Resend invitation"),
    );
    resend?.click();
    await flush();
    expect(
      calls.find((call) => call.query.includes("ResendInvitation"))?.variables,
    ).toEqual({ userId: "user-1" });
    expect(activeToasts().map((toast) => toast.message)).toContain(
      "Too many requests; try again later",
    );
    dispose();
    container.remove();
  });

  test("shows accepted users as active and reloads after createUser errors", async () => {
    const calls: RequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      async (_url: RequestInfo | URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as RequestBody;
        calls.push(body);
        if (body.query.includes("query Users")) {
          return response({
            data: { users: [user({ invitationStatus: "ACCEPTED" })] },
          });
        }
        if (body.query.includes("mutation CreateUser")) {
          return response({
            errors: [
              {
                message: "An account with this email already exists",
                extensions: { code: "CONFLICT" },
              },
            ],
          });
        }
        throw new Error(`Unexpected GraphQL request: ${body.query}`);
      },
    );
    const { container, dispose } = mountUsers();
    await flush();
    expect(container.textContent).toContain("Active");
    expect(
      Array.from(container.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Resend invitation"),
      ),
    ).toBe(false);

    const email = container.querySelector<HTMLInputElement>("#user-email");
    const name = container.querySelector<HTMLInputElement>("#user-name");
    if (email === null || name === null) {
      throw new Error("invite form inputs not found");
    }
    email.value = "pending@example.test";
    email.dispatchEvent(new Event("input", { bubbles: true }));
    name.value = "Pending User";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Invite user"))
      ?.click();
    await flush();
    expect(
      calls.filter((call) => call.query.includes("query Users")),
    ).toHaveLength(2);
    expect(activeToasts().map((toast) => toast.message)).toContain(
      "An account with this email already exists",
    );
    dispose();
    container.remove();
  });
});
