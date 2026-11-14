import { render } from "solid-js/web";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TurnstileRenderOptions } from "../lib/turnstile";
import LoginPage from "./login-page";

const turnstileScript =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mountLogin() {
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = render(() => <LoginPage />, container);
  return { container, dispose };
}

function enterEmail(container: HTMLElement): void {
  const input = container.querySelector<HTMLInputElement>("#login-email");
  if (input === null) {
    throw new Error("login email input not found");
  }
  input.value = "person@example.test";
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.turnstile;
  for (const script of document.querySelectorAll(
    `script[src="${turnstileScript}"]`,
  )) {
    script.remove();
  }
});

describe("login Turnstile behavior", () => {
  test("does not load the widget when public config disables it", async () => {
    const calls: Array<{ query: string; variables?: Record<string, unknown> }> =
      [];
    vi.stubGlobal(
      "fetch",
      async (_url: RequestInfo | URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as (typeof calls)[number];
        calls.push(body);
        return jsonResponse(
          body.query.includes("PublicConfig")
            ? { data: { publicConfig: { turnstileSiteKey: null } } }
            : { data: { requestEmailAuth: true } },
        );
      },
    );
    const { container, dispose } = mountLogin();
    await flush();
    expect(
      document.querySelector(`script[src="${turnstileScript}"]`),
    ).toBeNull();
    enterEmail(container);
    const submit = container.querySelector<HTMLButtonElement>(
      "button[type=submit]",
    );
    expect(submit?.disabled).toBe(false);
    submit?.click();
    await flush();
    expect(calls[1]?.variables).toEqual({
      email: "person@example.test",
      turnstileToken: null,
    });
    expect(container.textContent).toContain("a sign-in link is on its way");
    dispose();
    container.remove();
  });

  test("requires a Turnstile token and resets it after success", async () => {
    const calls: Array<{ query: string; variables?: Record<string, unknown> }> =
      [];
    vi.stubGlobal(
      "fetch",
      async (_url: RequestInfo | URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as (typeof calls)[number];
        calls.push(body);
        return jsonResponse(
          body.query.includes("PublicConfig")
            ? {
                data: { publicConfig: { turnstileSiteKey: "public-site-key" } },
              }
            : { data: { requestEmailAuth: true } },
        );
      },
    );
    const renderWidget = vi.fn(
      (_element: HTMLElement, _options: TurnstileRenderOptions) => "widget-1",
    );
    const reset = vi.fn();
    const remove = vi.fn();
    const { container, dispose } = mountLogin();
    await flush();
    window.turnstile = { render: renderWidget, reset, remove };
    const script = document.querySelector<HTMLScriptElement>(
      `script[src="${turnstileScript}"]`,
    );
    script?.dispatchEvent(new Event("load"));
    await flush();
    expect(renderWidget).toHaveBeenCalledOnce();
    const options = renderWidget.mock.calls[0]?.[1];
    expect(options).toMatchObject({
      sitekey: "public-site-key",
      action: "login",
      theme: "auto",
    });

    enterEmail(container);
    const submit = container.querySelector<HTMLButtonElement>(
      "button[type=submit]",
    );
    expect(submit?.disabled).toBe(true);
    options?.callback("single-use-token");
    expect(submit?.disabled).toBe(false);
    options?.["expired-callback"]();
    expect(submit?.disabled).toBe(true);
    options?.callback("single-use-token");
    expect(submit?.disabled).toBe(false);
    submit?.click();
    await flush();
    expect(calls[1]?.variables).toEqual({
      email: "person@example.test",
      turnstileToken: "single-use-token",
    });
    expect(reset).toHaveBeenCalledWith("widget-1");
    expect(container.textContent).toContain("a sign-in link is on its way");
    dispose();
    expect(remove).toHaveBeenCalledWith("widget-1");
    container.remove();
  });

  test("shows script loading failure and keeps submit disabled", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse({
        data: { publicConfig: { turnstileSiteKey: "public-site-key" } },
      }),
    );
    const { container, dispose } = mountLogin();
    await flush();
    const script = document.querySelector<HTMLScriptElement>(
      `script[src="${turnstileScript}"]`,
    );
    script?.dispatchEvent(new Event("error"));
    await flush();
    enterEmail(container);
    expect(container.textContent).toContain(
      "Could not load verification. Reload the page.",
    );
    expect(
      container.querySelector<HTMLButtonElement>("button[type=submit]")
        ?.disabled,
    ).toBe(true);
    dispose();
    container.remove();
  });

  test("shows the verification error and resets after a rejected attempt", async () => {
    vi.stubGlobal(
      "fetch",
      async (_url: RequestInfo | URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { query: string };
        if (body.query.includes("PublicConfig")) {
          return jsonResponse({
            data: { publicConfig: { turnstileSiteKey: "public-site-key" } },
          });
        }
        return jsonResponse({
          errors: [
            {
              message: "Verification failed. Please retry.",
              extensions: { code: "FORBIDDEN" },
            },
          ],
        });
      },
    );
    const reset = vi.fn();
    let widgetOptions: TurnstileRenderOptions | undefined;
    const { container, dispose } = mountLogin();
    await flush();
    window.turnstile = {
      render: (_element, options) => {
        widgetOptions = options;
        return "widget-1";
      },
      reset,
      remove: vi.fn(),
    };
    const script = document.querySelector<HTMLScriptElement>(
      `script[src="${turnstileScript}"]`,
    );
    script?.dispatchEvent(new Event("load"));
    await flush();
    const submit = container.querySelector<HTMLButtonElement>(
      "button[type=submit]",
    );
    enterEmail(container);
    expect(submit?.disabled).toBe(true);
    widgetOptions?.callback("single-use-token");
    submit?.click();
    await flush();
    expect(container.textContent).toContain(
      "Verification failed. Please retry.",
    );
    expect(reset).toHaveBeenCalledWith("widget-1");
    expect(submit?.disabled).toBe(true);
    dispose();
    container.remove();
  });

  test("fails closed when public config cannot be loaded", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse({
        errors: [{ message: "offline", extensions: { code: "UNKNOWN" } }],
      }),
    );
    const { container, dispose } = mountLogin();
    await flush();
    expect(container.textContent).toContain(
      "Could not load sign-in settings. Reload the page.",
    );
    expect(
      container.querySelector<HTMLButtonElement>("button[type=submit]")
        ?.disabled,
    ).toBe(true);
    dispose();
    container.remove();
  });
});
