import { afterEach, describe, expect, test } from "vitest";
import { loadTurnstile, TURNSTILE_SCRIPT_URL } from "./turnstile";

describe("loadTurnstile", () => {
  afterEach(() => {
    delete window.turnstile;
    for (const script of document.querySelectorAll(
      `script[src="${TURNSTILE_SCRIPT_URL}"]`,
    )) {
      script.remove();
    }
  });

  test("shares one script load and retries after a failed load", async () => {
    const first = loadTurnstile();
    const second = loadTurnstile();
    const scripts = document.querySelectorAll("script");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.getAttribute("src")).toBe(TURNSTILE_SCRIPT_URL);

    scripts[0]?.dispatchEvent(new Event("error"));
    await expect(first).rejects.toThrow("Turnstile script failed to load");
    await expect(second).rejects.toThrow("Turnstile script failed to load");
    expect(scripts[0]?.isConnected).toBe(false);

    const api = {
      render: () => "widget",
      reset: () => undefined,
      remove: () => undefined,
    };
    const retry = loadTurnstile();
    const retryScript = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT_URL}"]`,
    );
    expect(document.querySelectorAll("script")).toHaveLength(1);
    expect(retryScript?.getAttribute("src")).toBe(TURNSTILE_SCRIPT_URL);
    window.turnstile = api;
    retryScript?.dispatchEvent(new Event("load"));
    await expect(retry).resolves.toBe(api);
  });

  test("rejects when the script loads without installing the API", async () => {
    const loading = loadTurnstile();
    const script = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT_URL}"]`,
    );

    script?.dispatchEvent(new Event("load"));

    await expect(loading).rejects.toThrow(
      "Turnstile script loaded without its API",
    );
  });
});
