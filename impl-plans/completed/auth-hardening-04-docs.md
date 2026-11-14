# Auth Hardening 04: Operator Documentation

**Status**: Completed
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
- impl-plans/completed/auth-hardening-04-docs.md (progress log only)

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

- [x] README Deploying and Bootstrapping match design section 8.
- [x] The skill has the first-deployment subsection.
- [x] DR-L1 and DR-L2 are fixed.
- [x] Verification steps 1-5 pass, with evidence recorded.

## Progress Log

### Session: 2026-10-07 Step 6
**Tasks Completed**: Updated README deployment and one-time bootstrap instructions, added the secrets/vars table and security-model link; added the cloudflare-mail-setup first-deployment order; fixed DR-L1 and DR-L2.
**Changed files**: `README.md`, `.agents/skills/cloudflare-mail-setup/SKILL.md`, `design-docs/specs/design-deployment.md`, `design-docs/specs/design-security-model.md`.
**Hashes** (SHA-256 before -> after):
- `README.md`: `5f8be4348436cf4e8a8fd941ab51aeddd0250450aff099fb0d7862167db7fb92` -> `dc7ee50694e742adb1d45e934182370e47bc2ec7cf85c8efd9c3bca3c3f4fb91`
- `.agents/skills/cloudflare-mail-setup/SKILL.md`: `4b98015aa3e3f6f15760fe5d16f7a53ac8547bb6643991e26c3fce9ee014d58c` -> `fd49996959c39947f995fc8dd4765f768d138dee4b3309ba5da733926f25dd41`
- `design-docs/specs/design-deployment.md`: `84d7a9ff5d0a2428d50d890bc1ca265f93dc9850c3f35596dd3e166762f9b95e` -> `faa00360d4324f639a4e2ec149f8ffad294787ad2c26899f349091ab31ddbe3b`
- `design-docs/specs/design-security-model.md`: `5cbf83ede99371c1dd12d282540c3fcd4d1698acc062d72d60b288d3df76d133` -> `531bcfe0fdb1edaacdbcc2030750fd798c43d1f4524a65d024da5d28ab0a9949`
**Verification evidence**: `tmp/auth-hardening-s305/auth-hardening-04-docs/step6-2/verification.tsv`; all five assigned checks plus link-target and diff checks exited 0, with complete logs in the same directory. The README links directly to the design document to avoid an uncertain heading anchor. An initial shell wrapper used a reserved variable name and was rerun with a corrected wrapper; no verification gate failed.

### Session: 2026-10-07 Step 6 verification rerun
**Tasks Completed**: Re-ran verification steps 1-5, the security-model link-target check, and `git diff --check` on the current shared tree; all exited 0.
**Verification evidence**: Complete logs and `.status` sidecars are in `tmp/auth-hardening-s305/auth-hardening-04-docs/step6-verify-20261007-01/`. The initial wrapper attempt stopped before checks because zsh reserves `status`; the corrected wrapper used `exit_code` and all checks passed.

### Session: 2026-10-07 Step 6 implementation rerun
**Tasks Completed**: Re-ran all assigned documentation checks, link target, DR-L1/DR-L2 markers, and `git diff --check` on the current shared tree; all checks exited 0. No runtime behavior changed, so behavioral tests do not apply to this documentation-only plan.
**Verification evidence**: Complete logs and exit-status sidecars are in `tmp/auth-hardening-s305/auth-hardening-04-docs/step6-implement-rerun-20261007-01/`. The initial wrapper invocation had a quoting error before the DR-L2 check; the direct DR-L2 check then passed and was captured in `dr_l2.log` with exit status 0.

### Session: 2026-10-07 Opus review corrections
**Tasks Completed**: Updated the deployed endpoint and managed-domain description in README; aligned README step 5 with design section 8, including bootstrap token generation, the minimum token length, and the temporary Turnstile/bootstrap state; moved the cloudflare-mail-setup first-deployment subsection below its numbered domain-registration list.
**Changed files**: `README.md`, `.agents/skills/cloudflare-mail-setup/SKILL.md`.
**Verification evidence**: Re-read the edited README sections against design section 8 and confirmed the deployment sequence and required wording; verified the skill intro is followed by steps 1-4, then the shortcut warning, then the first-deployment subsection. `bunx biome check README.md` was not run because README.md is Markdown and the requested verification is a content comparison.

### Session: 2026-10-07 orchestrator completion
The riela workflow accepted 01, 03, 05 and 06; its implementation-progress-check gate rejected valid evidence for 02 (web tests 273/273) and 04 (docs-only) three times, so the orchestrator continued with GPT-6 Luna implementing 07, 08 and 09 and read-only Opus reviews: 02 APPROVED (W1-W5 fixed), 04 CHANGES_REQUESTED (D1-D3 fixed), 07 APPROVED (N1-N4 tests added), 08 CHANGES_REQUESTED (C1-C2, S1-S3, E1 IPv6 /64 keying, E2 bounded in-memory limiter fixed). Final gate: mise run lint exit 0; bun run test 1830 package + 274 web tests; build-web and Worker dry run exit 0. Deployed to https://mail.tacoserve.online (workers.dev 404) on a fresh D1 with migrations 0001-0015; bootstrap via mise run bootstrap-admin with the deploy-time token succeeded once, a second attempt returned CONFLICT, and the bootstrap secret was deleted; wrong token -> FORBIDDEN; missing Turnstile token -> FORBIDDEN; parallel burst -> RATE_LIMITED; CSP adds only challenges.cloudflare.com; Turnstile widget renders and blocks headless automation.
