import { createSignal, type JSX, Show } from "solid-js";
import { REQUEST_EMAIL_AUTH_MUTATION } from "../api/documents";
import { publicGraphqlRequest } from "../api/graphql-client";
import { describeErrors } from "../lib/mutation-error";
import "./login-page.css";

export default function LoginPage(): JSX.Element {
  const [email, setEmail] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await publicGraphqlRequest<
      { readonly requestEmailAuth: boolean },
      Record<string, unknown>
    >(REQUEST_EMAIL_AUTH_MUTATION, { email: email().trim() });
    setSubmitting(false);
    if (!result.ok) {
      setError(describeErrors(result.errors));
      return;
    }
    // The server always reports success, whether or not the address is
    // known, so this screen must not imply the address exists either.
    setSent(true);
  }

  return (
    <main class="login-page">
      <h1>mailcal</h1>
      <Show
        when={!sent()}
        fallback={
          <p>
            If that address belongs to an account, a sign-in link is on its way.
            The link expires in 15 minutes and can be used once.
          </p>
        }
      >
        <form onSubmit={(event) => void submit(event)}>
          <div class="field">
            <label for="login-email">Email address</label>
            <input
              id="login-email"
              type="email"
              required
              autocomplete="email"
              value={email()}
              onInput={(event) => setEmail(event.currentTarget.value)}
            />
          </div>
          <Show when={error() !== null}>
            <p class="error-text">{error()}</p>
          </Show>
          <button type="submit" class="primary" disabled={submitting()}>
            {submitting() ? "Sending..." : "Email me a sign-in link"}
          </button>
        </form>
      </Show>
    </main>
  );
}
