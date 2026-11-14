import { createSignal, onCleanup, onMount, type JSX, Show } from "solid-js";
import {
  PUBLIC_CONFIG_QUERY,
  REQUEST_EMAIL_AUTH_MUTATION,
} from "../api/documents";
import { publicGraphqlRequest } from "../api/graphql-client";
import { describeErrors } from "../lib/mutation-error";
import { loadTurnstile, type TurnstileApi } from "../lib/turnstile";
import "./login-page.css";

export default function LoginPage(): JSX.Element {
  const [email, setEmail] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [configLoaded, setConfigLoaded] = createSignal(false);
  const [configFailed, setConfigFailed] = createSignal(false);
  const [turnstileEnabled, setTurnstileEnabled] = createSignal(false);
  const [turnstileToken, setTurnstileToken] = createSignal<string | null>(null);
  const [turnstileApi, setTurnstileApi] = createSignal<TurnstileApi | null>(
    null,
  );
  const [widgetId, setWidgetId] = createSignal<string | null>(null);
  let widgetContainer: HTMLDivElement | undefined;
  let disposed = false;

  onMount(() => {
    void (async () => {
      const result = await publicGraphqlRequest<{
        readonly publicConfig: { readonly turnstileSiteKey: string | null };
      }>(PUBLIC_CONFIG_QUERY);
      if (disposed) {
        return;
      }
      if (!result.ok) {
        setConfigFailed(true);
        setError("Could not load sign-in settings. Reload the page.");
        return;
      }
      setConfigLoaded(true);
      const sitekey = result.data.publicConfig.turnstileSiteKey;
      if (sitekey === null) {
        return;
      }
      setTurnstileEnabled(true);
      try {
        const api = await loadTurnstile();
        if (disposed || widgetContainer === undefined) {
          return;
        }
        const id = api.render(widgetContainer, {
          sitekey,
          action: "login",
          theme: "auto",
          callback: setTurnstileToken,
          "expired-callback": () => setTurnstileToken(null),
          "error-callback": () => setTurnstileToken(null),
        });
        setTurnstileApi(api);
        setWidgetId(id);
      } catch {
        if (!disposed) {
          setError("Could not load verification. Reload the page.");
        }
      }
    })();
  });

  onCleanup(() => {
    disposed = true;
    const api = turnstileApi();
    const id = widgetId();
    if (api !== null && id !== null) {
      try {
        api.remove(id);
      } catch {
        // Widget cleanup must not interrupt page disposal.
      }
    }
  });

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    if (
      !configLoaded() ||
      configFailed() ||
      (turnstileEnabled() && (widgetId() === null || turnstileToken() === null))
    ) {
      return;
    }
    setSubmitting(true);
    setError(null);
    let sent = false;
    try {
      const result = await publicGraphqlRequest<
        { readonly requestEmailAuth: boolean },
        Record<string, unknown>
      >(REQUEST_EMAIL_AUTH_MUTATION, {
        email: email().trim(),
        turnstileToken: turnstileToken(),
      });
      if (!result.ok) {
        const verificationError = result.errors.find(
          (requestError) => requestError.code === "FORBIDDEN",
        );
        setError(verificationError?.message ?? describeErrors(result.errors));
        return;
      }
      // The server always reports success, whether or not the address is
      // known, so this screen must not imply the address exists either.
      sent = true;
    } finally {
      const api = turnstileApi();
      const id = widgetId();
      if (api !== null && id !== null) {
        try {
          api.reset(id);
        } catch {
          // The request result must not depend on widget cleanup succeeding.
        }
      }
      setTurnstileToken(null);
      setSubmitting(false);
    }
    if (sent) {
      setSent(true);
    }
  }

  return (
    <main class="login-page">
      <header class="login-header">
        <p class="login-brand">flying-mail</p>
        <h1>Log in to flying-mail</h1>
        <p class="login-intro">Open your mailbox to read and send email.</p>
      </header>
      <Show
        when={!sent()}
        fallback={
          <section
            class="login-confirmation"
            aria-labelledby="login-sent-title"
          >
            <h2 id="login-sent-title">Check your email</h2>
            <p>
              If that address belongs to an account, a sign-in link is on its
              way. The link expires in 15 minutes and can be used once.
            </p>
            <p class="muted">If you don’t see it, check your spam folder.</p>
          </section>
        }
      >
        <form onSubmit={(event) => void submit(event)}>
          <p id="login-email-help" class="login-guidance">
            Enter the email address associated with your account. We’ll send you
            a one-time sign-in link. No password needed.
          </p>
          <div class="field">
            <label for="login-email">Email address</label>
            <input
              id="login-email"
              type="email"
              required
              autocomplete="email"
              aria-describedby="login-email-help"
              value={email()}
              onInput={(event) => setEmail(event.currentTarget.value)}
            />
          </div>
          <Show when={turnstileEnabled()}>
            <div class="login-verification" ref={widgetContainer} />
          </Show>
          <Show when={error() !== null}>
            <p class="error-text" role="alert">
              {error()}
            </p>
          </Show>
          <button
            type="submit"
            class="primary"
            disabled={
              submitting() ||
              !configLoaded() ||
              configFailed() ||
              (turnstileEnabled() &&
                (widgetId() === null || turnstileToken() === null))
            }
          >
            {submitting() ? "Sending..." : "Email me a sign-in link"}
          </button>
        </form>
      </Show>
    </main>
  );
}
