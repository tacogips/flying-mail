export const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export interface TurnstileRenderOptions {
  readonly sitekey: string;
  readonly action: string;
  readonly theme: "auto" | "light" | "dark";
  readonly callback: (token: string) => void;
  readonly "expired-callback": () => void;
  readonly "error-callback": () => void;
}

export interface TurnstileApi {
  render(element: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** Loads Cloudflare Turnstile once and allows a later retry after script failure. */
export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile !== undefined) {
    return Promise.resolve(window.turnstile);
  }
  if (loading !== null) {
    return loading;
  }

  const pending = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.turnstile === undefined) {
        reject(new Error("Turnstile script loaded without its API"));
        return;
      }
      resolve(window.turnstile);
    };
    script.onerror = () => {
      script.remove();
      reject(new Error("Turnstile script failed to load"));
    };
    document.head.append(script);
  });
  loading = pending.then(
    (api) => {
      loading = null;
      return api;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}
