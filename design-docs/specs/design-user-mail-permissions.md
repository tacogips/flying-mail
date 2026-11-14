# User Roles and Mail Permissions

This document defines interactive-user authorization. API keys continue to use
the capability scopes in `design-api-keys-and-permissions.md`; user permissions
and API-key scopes are deliberately evaluated independently.

## Overview

Users have one of three roles:

| Role | Default mail access | Mail actions | Administration |
|------|---------------------|--------------|----------------|
| `ADMIN` | Every managed mailbox | Read, send, manage, and open attachments | Domains, API keys, users, roles, and user mail permissions |
| `MEMBER` | None | Read, send, manage, and open attachments on assigned targets | None |
| `VIEWER` | None | Read and open attachments on assigned targets | None |

An admin can explicitly deny an admin access to a mailbox even though the
admin role normally covers all mail. Member and viewer access is granted by an
admin. A viewer can never send or mutate mail, regardless of its assignments.

## Permission Rules

```typescript
enum UserPermissionEffect {
  Allow = "ALLOW",
  Deny = "DENY",
}

interface UserMailPermission {
  readonly id: UserMailPermissionId;
  readonly userId: UserId;
  readonly effect: UserPermissionEffect;
  readonly domainId: DomainId | null;
  readonly addressPattern: AddressPattern;
  readonly createdByUserId: UserId;
  readonly createdAt: string;
}
```

`domainId: null` means every managed domain. `addressPattern` uses the finite
grammar in `design-domain-model.md`, so both domain-wide (`*@example.com`) and
exact-address (`support@example.com`) assignments are supported. A rule with a
specific `domainId` and `"*"` is the canonical domain-level assignment.

For one candidate mailbox, authorization is evaluated in this order:

1. A matching `DENY` always rejects the candidate.
2. `ADMIN` otherwise receives all mail capabilities.
3. `MEMBER` requires a matching `ALLOW` and receives `MAIL_READ`, `MAIL_SEND`,
   `MAIL_MANAGE`, and `FILE_LINK`.
4. `VIEWER` requires a matching `ALLOW` and receives only `MAIL_READ` and
   `FILE_LINK`.
5. `DOMAIN_ADMIN` and `KEY_ADMIN` remain `ADMIN`-only and are never affected
   by mailbox rules.

When a message has multiple authorization addresses, it is visible if at
least one candidate address is authorized. A deny removes access through the
denied mailbox; it does not hide the same message when another independently
authorized mailbox also received it.

Listing queries must preserve the `(effect, domainId, addressPattern)` tuple.
They must not split domain IDs and patterns into independent lists, because
doing so creates an unsafe cross-product. The SQL predicate applies matching
denies first and then requires either the admin baseline or a matching allow.
Specific reads outside the effective rule set return `NOT_FOUND`.

## Administration

Only an authenticated `ADMIN` user can list users, create users, change roles,
deactivate/reactivate users, and add or remove user mail permissions. API keys
cannot perform user administration, even if they hold `KEY_ADMIN`.

The system must always retain at least one active admin. A mutation that would
demote or deactivate the last active admin is rejected. An admin may add a
mailbox deny to itself because that does not remove administrative authority.

User creation sends no password: the new user signs in through the existing
passwordless email flow. Deactivated users cannot sign in, and permission
changes take effect on the next request because the session resolver reloads
the user and its current permission rules.

## API Surface

GraphQL exposes admin-only `users` and `user(id:)` queries plus mutations to
create users, set roles, set active state, and add/remove mail-permission
rules. The web client provides `/settings/users` with role and scoped-rule
editing. Domain and exact-address targets use the same scope-builder language
as API keys, while the role determines which mail actions are possible.

## References

See `design-docs/references/README.md` for external references.
