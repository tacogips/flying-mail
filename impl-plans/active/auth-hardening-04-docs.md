# Auth Hardening 04: Operator Documentation

**Status**: Ready
**Plan ID**: auth-hardening-04-docs
**Wave**: 1 (phase 17)
**Depends On**: none (documents the names pinned in the accepted design)
**Design Reference**: design-docs/specs/design-security-model.md section 8 (normative first-deploy procedure), sections 3.5, 5.1, 7; Step 3 review findings DR-L1 and DR-L2
**Created**: 2026-10-07

## Intent and context

This plan mirrors the security model and first-deploy procedure into the
operator-facing docs, and fixes the two low findings from design review:

- **DR-L1**: the paragraph inside the env table in `design-deployment.md`
  breaks the table's rendering.
- **DR-L2**: the wrangler snippet in design section 7.1 is partial, but
  does not say so.

The names it documents are pinned by the design:

- `mise run bootstrap-admin`
- `flying-mail admin bootstrap`
- `FLYING_MAIL_BOOTSTRAP_TOKEN`
- `FLYING_MAIL_TURNSTILE_SECRET_KEY`
- `FLYING_MAIL_TURNSTILE_SITE_KEY`
- `FLYING_MAIL_INVITE_TTL_SECONDS`
- `AUTH_RATE_LIMITER`
- `mail.tacoserve.online`
- `.private/bootstrap-admin-api-key`

## Non-goals

- No code. No `wrangler.toml` edits; plan 08 owns that file.
- No new design decisions. Copy the design; do not reinterpret it.
- No secret values, and no real site key, anywhere.

## writePaths

- README.md
- .agents/skills/cloudflare-mail-setup/SKILL.md
- design-docs/specs/design-deployment.md
- design-docs/specs/design-security-model.md (section 7.1 note only)
- impl-plans/active/auth-hardening-04-docs.md (progress log only)

sharedPaths: none.

## File-level changes

### `README.md`

- "Deploying":
  - Replace it with a short numbered version of design section 8: Turnstile
    widget, then deploy, then secrets, then mail setup, then
    `kinko exec -- env FLYING_MAIL_ENDPOINT=https://mail.tacoserve.online mise run bootstrap-admin <email> <name>`,
    then delete the bootstrap secret, then sign in and invite users.
  - Mention the custom domain `mail.tacoserve.online`, and that
    `workers_dev` and `preview_urls` are disabled.
  - Add a variables/secrets table listing the three secrets and vars:
    - `FLYING_MAIL_BOOTSTRAP_TOKEN` (secret)
    - `FLYING_MAIL_TURNSTILE_SECRET_KEY` (secret)
    - `FLYING_MAIL_TURNSTILE_SITE_KEY` (var)
    - `FLYING_MAIL_INVITE_TTL_SECONDS` (var)
- "Bootstrapping a fresh deployment":
  - Replace the unauthenticated curl example. Bootstrap needs the token and
    works once, on an empty instance.
  - Show the mise task as the primary method.
  - Optionally show curl with `variables` and a `$FLYING_MAIL_BOOTSTRAP_TOKEN`
    placeholder. Never show a literal token value.
  - Say that the key is written to `.private/bootstrap-admin-api-key` and
    only its prefix is printed.
- Add a short "Security model" paragraph:
  - invite-only onboarding
  - Turnstile on the login-link request
  - per-IP rate limiting returning `RATE_LIMITED`
  - a link to `design-docs/specs/design-security-model.md`
- In the Documentation table, add a `design-security-model.md` row.
- Remove any mention of self-signup or `FLYING_MAIL_SIGNUP`.

### `.agents/skills/cloudflare-mail-setup/SKILL.md`

Add a short "First deployment order" subsection under "Then, in flying-mail
itself" that covers:

- `FLYING_MAIL_PUBLIC_ORIGIN` must be `https://mail.tacoserve.online`, so
  that login and invitation links resolve.
- Bootstrap through `mise run bootstrap-admin` after mail sending is
  verified.
- Invitations are sent from `FLYING_MAIL_MAIL_FROM`, so a failed invitation
  send is diagnosed exactly like a login-link send.

Keep the skill's existing structure.

### `design-docs/specs/design-deployment.md` (DR-L1)

- Move the paragraph "There is no self-signup setting. ..." from inside
  the Environment variables table to directly **below** the table, so
  every row renders as one table.
- Change no row content.

### `design-docs/specs/design-security-model.md` (DR-L2)

- Directly before the toml block in section 7.1, add one sentence: "The
  block lists only new or changed keys; every existing binding and var
  (`[[d1_databases]]`, `[[r2_buckets]]`, `[[send_email]]`, `[assets]`,
  `FLYING_MAIL_MAIL_FROM`, `FLYING_MAIL_SPAM_THRESHOLD`,
  `FLYING_MAIL_FILE_LINK_MAX_TTL`) is kept; only `FLYING_MAIL_SIGNUP` is
  removed."
- Change nothing else in the design.

## Pitfalls

- Do not paste real secret values, real site keys or account IDs.
- Use plain ASCII. No emojis.
- Keep README instructions consistent with design section 8, including the
  order: the site key is deployed **before** the Turnstile secret is put.

## Verification (from the repository root)

1. `rg -n -i "signup" README.md .agents` must print nothing.
2. `rg -n "bootstrap-admin|FLYING_MAIL_BOOTSTRAP_TOKEN|FLYING_MAIL_TURNSTILE_SECRET_KEY|FLYING_MAIL_TURNSTILE_SITE_KEY|mail.tacoserve.online" README.md`
   must show each term at least once.
3. `rg -n -F 'name: \"You\") { secret' README.md` must print nothing:
   there is no inline-literal, token-less curl example left.
4. `rg -n -A1 "FLYING_MAIL_S3_" design-docs/specs/design-deployment.md`:
   the env table rows must be contiguous lines that start with `|`, and the
   "There is no self-signup setting" paragraph must come after the last row.
5. Run an emoji scan over the touched files with
   `rg -n "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]"`. It must print nothing.

## Done criteria

- [ ] README Deploying and Bootstrapping match design section 8.
- [ ] The skill has the first-deployment subsection.
- [ ] DR-L1 and DR-L2 are fixed.
- [ ] Verification steps 1-5 pass, with evidence recorded.

## Progress Log

### Session: (not started)
**Tasks Completed**: none
**Hashes**: -
**Verification evidence**: -
