# Pending: USER_ADMIN capability and event-type filter decisions

Design: `design-docs/specs/design-user-admin-capability.md`. Each item below
already has a default **applied** in the design, so implementation is not
blocked. Each one is waiting for user confirmation and can be changed
later.

## U1. Adding USER_ADMIN to an existing key

- **Applied default:** `addApiKeyScope(USER_ADMIN)` is allowed only from an
  ADMIN session, and only on a key that the same admin created. The admin
  who granted the capability is therefore always the liveness anchor.
- Alternative A: allow any ADMIN session. The anchor would then stay the
  key's original creator, who may be a different admin.
- Alternative B: refuse `addApiKeyScope(USER_ADMIN)` entirely, so the
  capability can be granted only when a key is created.

## U2. Extra confirmation when granting USER_ADMIN in the web UI

- **Applied default:** no extra confirmation step. The scope builder shows a
  fixed description of what the capability can and cannot do, and the
  server enforces that only an admin session can grant it.
- Alternative: a confirm dialog before issuing a key that includes
  USER_ADMIN.

## U3. Invalid `MailEventScope.types` values

- **Applied default:** an empty list, and any list containing `LIVE`, are
  rejected with `BAD_USER_INPUT`. `LIVE` is always delivered.
- Alternative: ignore `LIVE` and treat an empty list as "all types".

## U4. Last-active-admin check under concurrency (residual risk)

- **Applied default:** the existing read-then-write check is kept unchanged
  for both sessions and USER_ADMIN keys. Two concurrent demotions of the
  last two admins could, in theory, both pass. This race already exists on
  the session path. API keys make concurrent automation more likely, but
  the race is no wider in kind.
- Alternative: an atomic conditional `UPDATE` in the user repository. This
  is a new port method and its own change.

## U5. USER_ADMIN keys see the domain catalogue

- **Applied default:** a USER_ADMIN scope is stored with `domainId: null`,
  like `KEY_ADMIN` and `DOMAIN_ADMIN`. Through the existing
  `visibleDomains` rule, the key can therefore list domain names and ids.
  It needs that to target and display domain-scoped user rules. It gains
  no mail access.
- Alternative: hide domains from USER_ADMIN-only keys. The CLI would then
  have to accept domain ids only.
