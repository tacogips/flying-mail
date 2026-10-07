# Pending: authentication hardening decisions

Design: `design-docs/specs/design-security-model.md`. Each item below already
has a default **applied** in the design. Implementation is not blocked. Each
item is waiting for user confirmation and can be changed later.

## P1. Where the bootstrap API key secret goes

The request says that the `bootstrap-admin` task "prints only the created
admin and the API key prefix". The full-capability key is shown once, and
discarding it would waste the only root credential the bootstrap produces.

- **Applied default:** the CLI writes the secret to
  `.private/bootstrap-admin-api-key` (exclusive create, mode 0600,
  gitignored by `.private*/`). It refuses to run if the file already exists,
  and it prints only the admin, the key prefix and the file path.
- Alternative A: discard the secret and rely on email sign-in for the
  admin. This is simpler, but the key cannot be recovered.
- Alternative B: print the secret to stderr. This contradicts "prints
  only".

## P2. Fail-fast on half-configured Turnstile or a short bootstrap token

- **Applied default:** composition throws, in line with the existing
  `FLYING_MAIL_PUBLIC_ORIGIN` policy. The error is visible immediately, but
  every request returns a masked 500 and inbound mail is retried by
  Cloudflare until it is fixed. The rollout order in section 8 (site key
  before secret) avoids this.
- Alternative: fail only the affected mutation (`SERVICE_UNAVAILABLE`) and
  keep the rest of the Worker up.

## P3. Rate-limit numbers and failure mode

- **Applied default:** 10 requests per 60 s per (operation, IP) for
  `requestEmailAuth`, `verifyEmailAuthToken` and `bootstrapAdmin`, using one
  `AUTH_RATE_LIMITER` binding (`namespace_id = "1001"`). If the binding
  errors, the request is allowed (fail open). Turnstile and the per-address
  throttle still apply.
- Alternative: stricter numbers, or fail closed on a binding error.

## P4. `preview_urls = false`

- **Applied default:** set together with `workers_dev = false`, because
  version preview URLs are also served on `workers.dev` and would bypass
  zone protection. Confirm that preview URLs are not used in any workflow.
