import { Router } from "@solidjs/router";
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppStore } from "../store/app-store";
import { StoreProvider } from "../store/store-context";
import EmailAuthVerifyPage from "./email-auth-verify-page";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Mounted {
  readonly container: HTMLElement;
  readonly dispose: () => void;
  readonly store: {
    rehydrateSession: ReturnType<typeof vi.fn>;
    loadReferenceData: ReturnType<typeof vi.fn>;
  };
}

function mount(): Mounted {
  const store = {
    rehydrateSession: vi.fn(async () => {}),
    loadReferenceData: vi.fn(async () => {}),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = render(
    () => (
      <Router
        root={() => (
          <StoreProvider store={store as unknown as AppStore}>
            <EmailAuthVerifyPage />
          </StoreProvider>
        )}
      />
    ),
    container,
  );
  return { container, dispose, store };
}

function button(container: HTMLElement): HTMLButtonElement {
  const found = container.querySelector("button");
  if (found === null) {
    throw new Error("continue button not found");
  }
  return found;
}

let mounted: Mounted | null = null;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  mounted?.dispose();
  mounted?.container.remove();
  mounted = null;
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("email auth verify page", () => {
  test("does not exchange the token until the button is clicked", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ data: { verifyEmailAuthToken: { expiresAt: "x" } } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    window.history.replaceState(null, "", "/auth/verify#token=secret-token");

    mounted = mount();
    await flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(button(mounted.container).textContent).toContain(
      "Continue to sign in",
    );
  });

  test("removes the token from the URL immediately", async () => {
    vi.stubGlobal("fetch", vi.fn());
    window.history.replaceState(null, "", "/auth/verify#token=secret-token");
    mounted = mount();
    await flush();
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("secret-token");
  });

  test("removes a legacy query token from the URL too", async () => {
    vi.stubGlobal("fetch", vi.fn());
    window.history.replaceState(null, "", "/auth/verify?token=legacy-token");
    mounted = mount();
    await flush();
    expect(window.location.search).toBe("");
    expect(window.location.href).not.toContain("legacy-token");
    expect(button(mounted.container)).toBeDefined();
  });

  test("exchanges the fragment token on click", async () => {
    const bodies: Array<{ variables?: { token?: string } }> = [];
    vi.stubGlobal(
      "fetch",
      async (_url: RequestInfo | URL, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as (typeof bodies)[number]);
        return jsonResponse({
          data: { verifyEmailAuthToken: { expiresAt: "2030-01-01T00:00:00Z" } },
        });
      },
    );
    window.history.replaceState(null, "", "/auth/verify#token=secret-token");
    mounted = mount();
    await flush();

    button(mounted.container).click();
    await flush();
    await flush();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.variables?.token).toBe("secret-token");
    expect(mounted.store.rehydrateSession).toHaveBeenCalledTimes(1);
    expect(mounted.store.loadReferenceData).toHaveBeenCalledTimes(1);
  });

  test("a double click exchanges only once", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ data: { verifyEmailAuthToken: { expiresAt: "x" } } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    window.history.replaceState(null, "", "/auth/verify#token=t");
    mounted = mount();
    await flush();

    const continueButton = button(mounted.container);
    continueButton.click();
    continueButton.click();
    await flush();
    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("shows the failure and offers a new link when the exchange fails", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse({
        errors: [
          { message: "Link expired", extensions: { code: "BAD_INPUT" } },
        ],
      }),
    );
    window.history.replaceState(null, "", "/auth/verify#token=t");
    mounted = mount();
    await flush();

    button(mounted.container).click();
    await flush();
    await flush();

    expect(mounted.container.textContent).toContain("Link expired");
    expect(mounted.container.querySelector('a[href="/login"]')).not.toBeNull();
    expect(mounted.store.rehydrateSession).not.toHaveBeenCalled();
  });

  test("a link without a token explains itself and has no button", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    window.history.replaceState(null, "", "/auth/verify");
    mounted = mount();
    await flush();

    expect(mounted.container.textContent).toContain("missing its token");
    expect(mounted.container.querySelector("button")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
