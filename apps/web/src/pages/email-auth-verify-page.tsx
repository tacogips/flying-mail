import { useNavigate, useSearchParams } from "@solidjs/router";
import { createSignal, type JSX, onMount, Show } from "solid-js";
import { VERIFY_EMAIL_AUTH_MUTATION } from "../api/documents";
import { publicGraphqlRequest, sessionStore } from "../api/graphql-client";
import { describeErrors } from "../lib/mutation-error";
import { useStore } from "../store/store-context";

export default function EmailAuthVerifyPage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const store = useStore();
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    void (async () => {
      const token = searchParams["token"];
      if (typeof token !== "string" || token.length === 0) {
        setError("This sign-in link is missing its token.");
        return;
      }
      // Deliberately a public request: the exchange must not be influenced
      // by whatever session the browser is already carrying.
      const result = await publicGraphqlRequest<
        { readonly verifyEmailAuthToken: { readonly expiresAt: string } },
        Record<string, unknown>
      >(VERIFY_EMAIL_AUTH_MUTATION, { token });
      if (!result.ok) {
        setError(describeErrors(result.errors));
        return;
      }
      // The server set the HttpOnly cookie on that response; re-reading the
      // viewer is what confirms it and populates the store.
      sessionStore.markEstablished();
      await store.rehydrateSession();
      await store.loadReferenceData();
      navigate("/", { replace: true });
    })();
  });

  return (
    <main class="login-page">
      <h1>Signing you in</h1>
      <Show when={error() !== null} fallback={<p>One moment...</p>}>
        <p class="error-text">{error()}</p>
        <a href="/login">Request a new link</a>
      </Show>
    </main>
  );
}
