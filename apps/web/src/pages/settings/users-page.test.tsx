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

interface TestPermission {
  readonly id: string;
  readonly effect: "ALLOW" | "DENY";
  readonly domain: { readonly id: string; readonly name: string } | null;
  readonly addressPattern: string;
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

function clickButton(container: HTMLElement, label: string): void {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (button === undefined) {
    throw new Error(`Button not found: ${label}`);
  }
  button.click();
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
    const resend = container.querySelector<HTMLButtonElement>(
      '[aria-label="Resend invitation to pending@example.test"]',
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

  test("a double click sends only one invitation resend", async () => {
    const calls: RequestBody[] = [];
    let finishResend: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      async (_url: RequestInfo | URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as RequestBody;
        calls.push(body);
        if (body.query.includes("query Users")) {
          return response({ data: { users: [user()] } });
        }
        if (body.query.includes("mutation ResendInvitation")) {
          return await new Promise<Response>((resolve) => {
            finishResend = resolve;
          });
        }
        throw new Error(`Unexpected GraphQL request: ${body.query}`);
      },
    );
    const { container, dispose } = mountUsers();
    await flush();
    const resend = container.querySelector<HTMLButtonElement>(
      '[aria-label="Resend invitation to pending@example.test"]',
    );
    if (resend === null) {
      throw new Error("Resend invitation button not found");
    }
    resend.click();
    resend.click();
    await flush();
    expect(
      calls.filter((call) => call.query.includes("mutation ResendInvitation")),
    ).toHaveLength(1);
    finishResend?.(response({ data: { resendInvitation: user() } }));
    await flush();
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
      container.querySelector(
        '[aria-label="Resend invitation to pending@example.test"]',
      ),
    ).toBeNull();

    const email = container.querySelector<HTMLInputElement>("#user-email");
    const name = container.querySelector<HTMLInputElement>("#user-name");
    if (email === null || name === null) {
      throw new Error("invite form inputs not found");
    }
    email.value = "pending@example.test";
    email.dispatchEvent(new Event("input", { bubbles: true }));
    name.value = "Pending User";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    clickButton(container, "Invite user");
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

describe("user list and editing", () => {
  test("renders compact rows with status and role-based mail summaries", async () => {
    const admin = user({
      id: "admin",
      name: "Admin User",
      email: "admin@example.test",
      role: "ADMIN",
      invitationStatus: "ACCEPTED",
    });
    const adminDenied = user({
      id: "admin-denied",
      name: "Admin with denial",
      email: "admin-denied@example.test",
      role: "ADMIN",
      permissions: [
        {
          id: "admin-deny-1",
          effect: "DENY",
          domain: { id: "domain-1", name: "example.test" },
          addressPattern: "blocked@example.test",
        },
      ],
    });
    const adminAllowed = user({
      id: "admin-allowed",
      name: "Admin with redundant allow",
      email: "admin-allowed@example.test",
      role: "ADMIN",
      permissions: [
        {
          id: "admin-allow-1",
          effect: "ALLOW",
          domain: { id: "domain-1", name: "example.test" },
          addressPattern: "redundant-only-mailbox.test",
        },
      ],
    });
    const member = user({
      id: "member",
      name: "Member User",
      email: "member@example.test",
      permissions: [
        {
          id: "allow-1",
          effect: "ALLOW",
          domain: { id: "domain-1", name: "example.test" },
          addressPattern: "*@example.test",
        },
        {
          id: "deny-1",
          effect: "DENY",
          domain: null,
          addressPattern: "blocked@example.test",
        },
      ],
    });
    const viewer = user({
      id: "viewer",
      name: "Viewer User",
      email: "viewer@example.test",
      role: "VIEWER",
      active: false,
    });
    vi.stubGlobal("fetch", async () =>
      response({
        data: { users: [admin, adminDenied, adminAllowed, member, viewer] },
      }),
    );
    const { container, dispose } = mountUsers();
    await flush();

    expect(container.querySelectorAll(".users-list__row")).toHaveLength(5);
    expect(container.textContent).toContain("All mailboxes");
    const deniedRow = container
      .querySelector<HTMLElement>(
        '.users-list__row [data-user-id="admin-denied"]',
      )
      ?.closest(".users-list__row");
    expect(deniedRow?.textContent).toContain("All mailboxes except");
    expect(deniedRow?.textContent).toContain(
      "DENY example.test blocked@example.test",
    );
    const allowedRow = container
      .querySelector<HTMLElement>(
        '.users-list__row [data-user-id="admin-allowed"]',
      )
      ?.closest(".users-list__row");
    expect(allowedRow?.textContent).toContain("All mailboxes");
    expect(allowedRow?.textContent).not.toContain(
      "redundant-only-mailbox.test",
    );
    expect(container.textContent).toContain("No mail access");
    expect(container.textContent).toContain(
      "ALLOW example.test *@example.test",
    );
    expect(container.textContent).toContain(
      "DENY All domains blocked@example.test",
    );
    expect(container.textContent).toContain("Role default");
    expect(container.textContent).toContain("Inactive");
    expect(container.textContent).toContain("Invitation pending");
    expect(
      deniedRow
        ?.querySelector(".users-list__chip--deny")
        ?.getAttribute("title"),
    ).toBe("DENY example.test blocked@example.test");
    dispose();
    container.remove();
  });

  test("opens the edit dialog with focus inside and Escape returns focus", async () => {
    vi.stubGlobal("fetch", async () =>
      response({ data: { users: [user({ invitationStatus: "ACCEPTED" })] } }),
    );
    const { container, dispose } = mountUsers();
    await flush();
    const edit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Edit",
    );
    if (edit === undefined) {
      throw new Error("Edit button not found");
    }
    expect(edit.getAttribute("aria-label")).toBe("Edit pending@example.test");
    edit.focus();
    edit.click();
    await flush();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-labelledby")).toBe("users-dialog-title");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Role for pending@example.test",
    );
    if (dialog === null) {
      throw new Error("Edit dialog not found");
    }
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled])",
      ),
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error("Dialog focusable controls not found");
    }
    first.focus();
    first.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(document.activeElement).toBe(last);
    last.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    expect(document.activeElement).toBe(first);
    edit.focus();
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    expect(document.activeElement).toBe(first);
    dialog?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(edit);
    dispose();
    container.remove();
  });

  test("adding and removing a mail rule refreshes the row summary", async () => {
    let permissions: TestPermission[] = [];
    const calls: RequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      async (_url: RequestInfo | URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as RequestBody;
        calls.push(body);
        if (body.query.includes("query Users")) {
          return response({ data: { users: [user({ permissions })] } });
        }
        if (body.query.includes("mutation AddUserMailPermission")) {
          const input = body.variables?.["input"] as {
            effect: "ALLOW" | "DENY";
            domainId: string | null;
            addressPattern: string;
          };
          permissions = [
            {
              id: "permission-1",
              effect: input.effect,
              domain:
                input.domainId === null
                  ? null
                  : { id: input.domainId, name: "example.test" },
              addressPattern: input.addressPattern,
            },
          ];
          return response({
            data: { addUserMailPermission: { id: "permission-1" } },
          });
        }
        if (body.query.includes("mutation RemoveUserMailPermission")) {
          permissions = [];
          return response({ data: { removeUserMailPermission: true } });
        }
        throw new Error(`Unexpected GraphQL request: ${body.query}`);
      },
    );
    const { container, dispose } = mountUsers();
    await flush();
    clickButton(container, "Edit");
    await flush();
    const pattern = container.querySelector<HTMLInputElement>(
      '[aria-label="Address pattern"]',
    );
    if (pattern === null) {
      throw new Error("Address pattern input not found");
    }
    pattern.value = "help@example.test";
    pattern.dispatchEvent(new Event("input", { bubbles: true }));
    clickButton(
      container.querySelector('[role="dialog"]') as HTMLElement,
      "Add rule",
    );
    await flush();
    expect(
      calls.some((call) => call.query.includes("AddUserMailPermission")),
    ).toBe(true);
    expect(container.querySelector(".users-list__chip")?.textContent).toBe(
      "ALLOW All domains help@example.test",
    );
    expect(
      container
        .querySelector('[aria-label="Role for pending@example.test"]')
        ?.closest('[role="dialog"]')
        ?.querySelector(
          '[aria-label="Remove ALLOW All domains help@example.test"]',
        ),
    ).not.toBeNull();
    clickButton(
      container.querySelector('[role="dialog"]') as HTMLElement,
      "Remove",
    );
    await flush();
    expect(
      calls.some((call) => call.query.includes("RemoveUserMailPermission")),
    ).toBe(true);
    expect(container.querySelector(".users-list__chip")?.textContent).toBe(
      "No mail access",
    );
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const edit = container.querySelector<HTMLButtonElement>(
      '[data-user-id="user-1"]',
    );
    clickButton(
      container.querySelector('[role="dialog"]') as HTMLElement,
      "Close",
    );
    await flush();
    expect(document.activeElement).toBe(edit);
    dispose();
    container.remove();
  });

  test("resends from the dialog and displays the last-admin error inline", async () => {
    const calls: RequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      async (_url: RequestInfo | URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as RequestBody;
        calls.push(body);
        if (body.query.includes("query Users")) {
          return response({ data: { users: [user({ role: "ADMIN" })] } });
        }
        if (body.query.includes("mutation SetUserRole")) {
          return response({
            errors: [
              {
                message:
                  "Cannot demote the last active admin; promote another user first",
                extensions: { code: "BAD_USER_INPUT" },
              },
            ],
          });
        }
        if (body.query.includes("mutation ResendInvitation")) {
          return response({ data: { resendInvitation: user() } });
        }
        throw new Error(`Unexpected GraphQL request: ${body.query}`);
      },
    );
    const { container, dispose } = mountUsers();
    await flush();
    clickButton(container, "Edit");
    await flush();
    const roleSelect = container.querySelector<HTMLSelectElement>(
      '[aria-label="Role for pending@example.test"]',
    );
    if (roleSelect === null) {
      throw new Error("Role select not found");
    }
    roleSelect.value = "MEMBER";
    roleSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(container.textContent).toContain(
      "Cannot demote the last active admin; promote another user first",
    );
    expect(roleSelect.value).toBe("ADMIN");
    clickButton(
      container.querySelector('[role="dialog"]') as HTMLElement,
      "Resend invitation",
    );
    await flush();
    expect(calls.some((call) => call.query.includes("ResendInvitation"))).toBe(
      true,
    );
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    if (dialog === null) {
      throw new Error("Edit dialog not found after mutation");
    }
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('[data-user-id="user-1"]'),
    );
    dispose();
    container.remove();
  });
});
