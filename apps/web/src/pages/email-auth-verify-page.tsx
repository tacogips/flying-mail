import { useNavigate } from "@solidjs/router";
import { createSignal, type JSX, Show } from "solid-js";
import { VERIFY_EMAIL_AUTH_MUTATION } from "../api/documents";
import {
  sessionEstablishingGraphqlRequest,
  sessionStore,
} from "../api/graphql-client";
import { extractLoginToken } from "../lib/login-token";
import { describeErrors } from "../lib/mutation-error";
import { useStore } from "../store/store-context";

/**
 * Landing page for an emailed sign-in link.
 *
 * The token is **not** exchanged on load. Two attacks make that unsafe:
 *
 * - **Login CSRF**: an attacker who obtains their own valid link can get a
 *   victim to open it, silently signing the victim into the attacker's
 *   account. Requiring a click makes the sign-in a visible, deliberate act.
 * - **Link scanners**: mail gateways and preview bots fetch URLs in
 *   messages, and many execute scripts. An exchange on mount would burn the
 *   single-use token before the person ever clicks.
 *
 * The token is read once, then stripped from the address bar so it does not
 * linger in history, screenshots or shared URLs.
 */
export default function EmailAuthVerifyPage(): JSX.Element {
  const navigate = useNavigate();
  const store = useStore();

  const extracted = extractLoginToken(window.location);
  window.history.replaceState(window.history.state, "", extracted.cleanedUrl);
  const token = extracted.token;

  const [error, setError] = createSignal<string | null>(
    token === null ? "This sign-in link is missing its token." : null,
  );
  const [pending, setPending] = createSignal(false);

  async function exchange(): Promise<void> {
    if (token === null || pending()) {
      return;
    }
    setPending(true);
    setError(null);
    // The exchange accepts the response cookie while remaining unauthenticated
    // by any session the browser is already carrying.
    const result = await sessionEstablishingGraphqlRequest<
      { readonly verifyEmailAuthToken: { readonly expiresAt: string } },
      Record<string, unknown>
    >(VERIFY_EMAIL_AUTH_MUTATION, { token });
    if (!result.ok) {
      setError(describeErrors(result.errors));
      setPending(false);
      return;
    }
    // The server set the HttpOnly cookie on that response; re-reading the
    // viewer is what confirms it and populates the store.
    sessionStore.markEstablished();
    await store.rehydrateSession();
    await store.loadReferenceData();
    navigate("/", { replace: true });
  }

  return (
    <main class="login-page">
      <h1>Confirm sign-in</h1>
      <Show when={token !== null}>
        <p>Continue to finish signing in to flying-mail in this browser.</p>
        <button
          type="button"
          disabled={pending()}
          onClick={() => {
            void exchange();
          }}
        >
          {pending() ? "Signing in..." : "Continue to sign in"}
        </button>
      </Show>
      <Show when={error() !== null}>
        <p class="error-text" role="alert">
          {error()}
        </p>
        <a href="/login">Request a new link</a>
      </Show>
    </main>
  );
}
