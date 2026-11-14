# API Keys and Permissions

mailcal is designed to be called by AI agents and unattended clients, so the
API key -- not the user session -- is the primary credential. A key is only
useful in combination with the scopes it was issued with: an unscoped key
grants nothing.

## Key format

```
ybm_<prefix>_<secret>
     ^^^^^^  ^^^^^^^^
     12 chars  43 chars (base64url of 32 random bytes)
```

- `prefix` is stored in clear text and is what the UI displays
  (`ybm_a1b2c3d4e5f6...`); it exists so a key can be identified and revoked
  without ever storing the secret.
- The **entire presented string** is SHA-256 hashed into `api_keys.key_hash`.
  Lookup is a single indexed query on that hash; the plaintext secret is
  returned exactly once, from the `createApiKey` mutation, and never again.
- Keys optionally carry `expiresAt`. Resolution rejects a key that is revoked,
  expired, or whose owning user has been deactivated.

## Capabilities

```typescript
enum Capability {
  MailRead    = "MAIL_READ",     // read messages, attachments, threads
  MailSend    = "MAIL_SEND",     // send outbound mail
  MailManage  = "MAIL_MANAGE",   // tag, mark spam, mark fetched, delete
  FileLink    = "FILE_LINK",     // mint temp file links
  DomainAdmin = "DOMAIN_ADMIN",  // create/verify/disable domains
  KeyAdmin    = "KEY_ADMIN",     // issue and revoke API keys
}
```

`MAIL_MANAGE` implies nothing about `MAIL_READ`: a key that may only
acknowledge fetches without reading bodies is a legitimate configuration, so
the capabilities are strictly independent and checked individually.

## Scopes

A scope is a `(capability, domain, addressPattern)` triple. A key holds one or
more; the key is authorized for an operation when **any** of its scopes
matches.

```typescript
interface ScopeMatchInput {
  readonly capability: Capability;
  readonly domainId: DomainId;
  readonly address: EmailAddress;
}
```

Matching rules, in order:

1. `scope.capability === input.capability` -- exact, never hierarchical.
2. `scope.domainId === null || scope.domainId === input.domainId`.
3. `matchAddressPattern(scope.addressPattern, input.address)` per the
   `AddressPattern` grammar in `design-domain-model.md`.

`DOMAIN_ADMIN` and `KEY_ADMIN` are instance-wide: they are checked with the
capability alone, ignoring domain/address, and a scope carrying them is stored
with `domainId: null, addressPattern: "*"`.

### Which address is matched

| Operation | Address matched against the scope |
|-----------|-----------------------------------|
| Read/list inbound messages | each `ENVELOPE` recipient of the message |
| Read outbound messages | the message's `fromAddress` |
| Send | the requested `from` address |
| Tag / mark spam / mark fetched / delete | same as reading that message |
| Mint a file link | same as reading the owning message |

Listing is filtered rather than rejected: `messages` returns only the rows the
key can see, so a scoped agent's pagination is consistent and it never learns
that other messages exist. Fetching a *specific* message it cannot see returns
`NOT_FOUND` (not `FORBIDDEN`), so a key cannot probe for the existence of
addresses outside its scope.

### Worked example

A support-desk agent that may read and reply to `support@example.com` only:

```
MAIL_READ    example.com  support@example.com
MAIL_SEND    example.com  support@example.com
MAIL_MANAGE  example.com  support@example.com
FILE_LINK    example.com  support@example.com
```

It cannot read `billing@example.com`, cannot send as any other mailbox,
cannot add domains, and cannot mint keys.

## Sessions

Browser users authenticate with passwordless email links, exactly as in the
reference project: `requestEmailAuth(email)` mails a single-use token,
`verifyEmailAuthToken(token)` exchanges it for a session and the server sets an
`HttpOnly; SameSite=Lax; Path=/` cookie (`Secure` unless the request is
plain-HTTP loopback). A CSRF origin backstop rejects non-safe-method requests
that present the cookie with a cross-origin `Origin` header; bearer-authorized
requests are exempt because a forged cross-site request cannot set headers.

## Viewer

Both credential kinds resolve to one discriminated union, which every use case
takes as its first argument:

```typescript
type Viewer =
  | { readonly kind: "USER"; readonly userId: UserId; readonly role: UserRole;
      readonly permissions: readonly UserMailPermission[] }
  | { readonly kind: "API_KEY"; readonly apiKeyId: ApiKeyId;
      readonly scopes: readonly ApiKeyScope[] };
```

A `USER` viewer is evaluated by role and current mail-permission rules as
defined in `design-user-mail-permissions.md`. An `API_KEY` viewer is authorized
purely by its scope list -- there is no implicit inheritance from the user that
created it, so changing a user's role or mail permissions does not silently
widen or narrow an existing key's reach.

The single policy module `packages/application/src/policies/authorization.ts`
owns every check; use cases call it rather than inspecting `Viewer` directly.

API-key scopes already support both requested granularities: a specific
`domainId` with `addressPattern: "*"` grants a whole domain, while an exact
address pattern grants one mailbox. These allow-only key scopes are separate
from user `ALLOW`/`DENY` rules.
