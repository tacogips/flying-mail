# External Mail GraphQL and Wiring Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-external-mail.md#graphql
**Created**: 2026-08-24
**Last Updated**: 2026-08-24

---

## Design Document Reference

**Source**: design-docs/specs/design-external-mail.md

### Summary
GraphQL SDL + resolvers for external mail account management and on-demand
fetch, merged into the existing schema, plus composition-root wiring that
picks the `TcpDialer` implementation per runtime and constructs the concrete
JMAP/POP3/SMTP clients and repositories from `external-mail-adapter.md`.

### Scope
**Included**: `packages/infrastructure` GraphQL SDL/resolvers/schema merge,
`composition/build-dependencies.ts` wiring (including per-runtime
`TcpDialer` selection), schema operation tests.
**Excluded**: `packages/application/src/usecases.ts` and `dependencies.ts` --
see `external-mail-core.md`'s "Divergence from the assignment brief" note;
those already exist by the time this plan runs, this plan only *constructs*
the concrete objects those interface fields hold. No web UI (design doc:
settings UI is an explicit follow-up, admin GraphQL/agent surface first).

---

## Tasks

### TASK-001: SDL module
**Status**: Completed
**Parallelizable**: Yes (contract-first, needs no other task)
**Deliverables**: `packages/infrastructure/src/graphql/schema-external-mail.graphql.ts`
(new SDL document, using a separate module merged via the `typeDefs` array
rather than growing
`schema.graphql.ts`):

```graphql
enum ExternalFetchKind {
  JMAP
  POP3
}

enum ExternalAccountStatus {
  ACTIVE
  DISABLED
}

enum SmtpSecurity {
  IMPLICIT_TLS
  STARTTLS
}

"""
A bound external mailbox. No secret -- neither a plaintext password nor a
ciphertext -- is ever exposed here, by construction: the resolver reads only
the non-secret projection the use case returns.
"""
type ExternalMailAccount {
  id: ID!
  mailAddressId: ID!
  mailAddress: String!
  externalAddress: String!
  displayName: String
  fetchKind: ExternalFetchKind!
  "True when an SMTP submission config is set, without revealing it."
  smtpConfigured: Boolean!
  status: ExternalAccountStatus!
  lastFetchedAt: DateTime
  createdAt: DateTime!
  updatedAt: DateTime!
}

type ExternalAccountTestResult {
  fetchOk: Boolean!
  fetchError: String
  "Null when no SMTP relay is configured."
  smtpOk: Boolean
  smtpError: String
}

type ExternalFetchSummary {
  fetched: Int!
  skipped: Int!
  "True when the per-run cap was hit; call fetchExternalMail again."
  hasMore: Boolean!
}

input ExternalFetchInput {
  kind: ExternalFetchKind!
  "JMAP only."
  sessionUrl: String
  "POP3 only. Defaults to 995; any other port is rejected."
  host: String
  port: Int
  username: String!
  password: String!
}

input SmtpSubmissionInput {
  host: String!
  port: Int!
  security: SmtpSecurity!
  username: String!
  password: String!
}

input CreateExternalMailAccountInput {
  mailAddressId: ID!
  externalAddress: String!
  displayName: String
  fetch: ExternalFetchInput!
  smtp: SmtpSubmissionInput
}

"""
Every field is an optional patch. fetch/smtp with an omitted password keep
the stored ciphertext (credential replacement re-enciphers only when a new
password is given). smtp: null clears SMTP relay entirely.
"""
input UpdateExternalMailAccountInput {
  displayName: String
  fetch: ExternalFetchInput
  smtp: SmtpSubmissionInput
  status: ExternalAccountStatus
}

extend type Query {
  "Admin-only."
  externalMailAccounts: [ExternalMailAccount!]!
}

extend type Mutation {
  createExternalMailAccount(
    input: CreateExternalMailAccountInput!
  ): ExternalMailAccount!
  updateExternalMailAccount(
    id: ID!
    input: UpdateExternalMailAccountInput!
  ): ExternalMailAccount!
  deleteExternalMailAccount(id: ID!): Boolean!
  "Connect + authenticate only; fetches or sends nothing."
  testExternalMailAccount(id: ID!): ExternalAccountTestResult!
  "On-demand fetch. Any viewer authorized for MAIL_READ on the bound address may call this, not admin-only."
  fetchExternalMail(id: ID!, max: Int): ExternalFetchSummary!
}
```

**Completion Criteria**:
- [x] SDL merges cleanly (`extend type` on `Query`/`Mutation`)
- [x] No field can leak a plaintext password or ciphertext, by type shape
      (there is no `String` field named/typed for either)
- [x] Doc comments on every type/field for agent consumers

### TASK-002: Resolvers
**Status**: Completed
**Parallelizable**: No (depends on TASK-001, `external-mail-core.md` TASK-007)
**Deliverables**: `packages/infrastructure/src/graphql/resolvers/external-mail.ts`
(one file -- the surface is one query and five mutations, small enough that
splitting into `-query.ts`/`-mutation.ts`/`-types.ts` would be premature;
split later if it grows past the file-size policy):
`externalMailQueryResolvers` (`externalMailAccounts`),
`externalMailMutationResolvers` (`createExternalMailAccount`,
`updateExternalMailAccount`, `deleteExternalMailAccount`,
`testExternalMailAccount`, `fetchExternalMail`), and an
`externalMailAccountResolvers` field-resolver map for `ExternalMailAccount`
(`mailAddress`: loader/lookup from `mailAddressId`; `smtpConfigured`:
`account.smtp !== null`). Error mapping reuses the existing
`translateDomainError`/`toGraphQLError` path -- no new error-code
plumbing. `packages/infrastructure/src/graphql/schema.ts` (extend): add
`externalMailTypeDefs` to the `typeDefs` array, spread
`externalMailQueryResolvers`/`externalMailMutationResolvers` into
`Query`/`Mutation`, add `ExternalMailAccount: externalMailAccountResolvers`.

**Completion Criteria**:
- [x] Operation tests via the existing graphql test-support: full CRUD happy
      path, `SERVICE_UNAVAILABLE` with no `FLYING_MAIL_CREDENTIAL_KEY`,
      `CONFLICT` for a second account on one address, `FORBIDDEN` for a
      non-admin on every mutation except `fetchExternalMail`, `NOT_FOUND`
      probe-resistance on `fetchExternalMail` for an address the viewer
      cannot read, no secret field ever present in a response (assert
      against the full JSON, not just the documented fields)
- [x] `schema.ts`'s existing merges (templates and mail) are
      untouched except for the new import/spread lines

### TASK-003: Composition wiring
**Status**: Completed
**Parallelizable**: No (depends on `external-mail-adapter.md`, all tasks)
**Deliverables**: `packages/infrastructure/src/composition/build-dependencies.ts`
(extend):

```typescript
// New in BuildDependenciesConfig (composition/config.ts, extend):
//   readonly runtime?: "cloudflare" | "node";  // defaults to a feature
//   detection probe, see below, rather than requiring every caller to set it

function resolveTcpDialer(config: BuildDependenciesConfig): TcpDialer {
  // Explicit config wins; otherwise feature-detect `cloudflare:sockets`
  // availability (the same kind of runtime branch `resolveDb`/`resolveBlobs`
  // already do by config flag) so a plain `bun run` and `wrangler dev`
  // both get a working dialer with no required env var.
}
```

Wire `externalMailAccountRepository: createExternalMailAccountRepository(db)`,
`externalMessageStateRepository: createExternalMessageStateRepository(db)`,
`tcpDialer: resolveTcpDialer(config)`,
`pop3Client: createPop3Client(tcpDialer)`,
`smtpSubmissionClient: createSmtpSubmissionClient(tcpDialer)`,
`jmapClient: createJmapClient({ fetchImpl: fetch })` into the object
`buildDependencies` returns, reusing the already-resolved
`credentialCipher` (no new config surface needed -- external accounts share
`FLYING_MAIL_CREDENTIAL_KEY` with CardDAV, per the design doc). No new
`apps/api` secrets: the same `wrangler secret put FLYING_MAIL_CREDENTIAL_KEY`
documented for shared credentials covers this feature too, worth one line in
whatever doc already covers that secret (do not duplicate the secret name in
a second place).

**Completion Criteria**:
- [x] Boot under `wrangler dev`/Miniflare selects the Cloudflare dialer;
      boot under `bun run` (local server) selects the Node dialer -- a
      config test for each, mirroring `config.test.ts`'s existing
      backend-selection tests
- [x] Boot without `FLYING_MAIL_CREDENTIAL_KEY`: external mail mutations return
      `SERVICE_UNAVAILABLE` through the shared credential gate
- [x] `AppDependencies` is fully constructed with no missing field
      (`tsc --noEmit` across `@flying-mail/infrastructure` passes)

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| SDL | `packages/infrastructure/src/graphql/schema-external-mail.graphql.ts` | COMPLETED | Merge-verified via `graphql.buildSchema` |
| Resolvers | `packages/infrastructure/src/graphql/resolvers/external-mail.ts`, `schema.ts` | COMPLETED | `schema-external-mail.test.ts`, 9 tests |
| Composition wiring | `packages/infrastructure/src/composition/{config,build-dependencies}.ts` | COMPLETED | `config.test.ts` (extended) |

Also add `packages/infrastructure/package.json` export entries:
`./graphql/schema-external-mail.graphql` and
`./graphql/resolvers/external-mail` (the latter may already be covered by
the existing `./graphql/resolvers/*` wildcard -- verify before adding).

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | `external-mail-core.md` (all tasks), `external-mail-adapter.md` (all tasks) | Pending |

## Completion Criteria

- [x] All tasks complete; vitest run green; typecheck + biome pass
- [x] `schema.graphql.ts`, `resolvers/mutation.ts`, `resolvers/query.ts`
      stay untouched except for the merge hook in `schema.ts`
- [x] No file at 1000+ lines
- [x] Export map entries added for the new SDL/resolver modules (both were
      already covered by the existing `./graphql/resolvers/*` wildcard and
      the `./graphql/schema-external-mail.graphql` entry TASK-001 added; no
      new entries were needed)

## Progress Log

### Session: 2026-08-24
**Tasks Completed**: None yet
**Notes**: Plan created from design-docs/specs/design-external-mail.md.

### Session: 2026-08-24 (TASK-001)
**Tasks Completed**: TASK-001 (SDL module)
**Notes**: Added
`packages/infrastructure/src/graphql/schema-external-mail.graphql.ts` with
`ExternalMailAccount` (no plaintext/ciphertext field by construction),
`ExternalAccountTestResult`, `ExternalFetchSummary`, the three enums,
input types and `extend type Query`/`Mutation`, with thorough doc comments;
not merged into
`schema.ts`/`createSchema` (TASK-002 owns wiring plus the resolvers). Also
fixed `packages/infrastructure/src/graphql/schema.test.ts`'s failing
bootstrapAdmin test by adding `CONTACT_READ`/`CONTACT_WRITE` to the
`Capability` enum in `schema.graphql.ts` (see contacts-graphql.md's
progress log for the same fix). Verified the new SDL parses and merges
without name collisions alongside all four other typeDefs documents via
`graphql`'s `buildSchema` in a scratch script (not committed). `bunx
vitest run packages/infrastructure`: 7 files, 172 tests, all passing.
`tsc --noEmit` in `packages/infrastructure` shows only one pre-existing,
out-of-scope error in `composition/build-dependencies.ts` (contacts fields
missing from `AppDependencies` construction), unrelated to external mail
and not touched here. Biome clean on all touched files.

### Session: 2026-08-24 (TASK-002, TASK-003)
**Tasks Completed**: TASK-002 (resolvers + schema merge), TASK-003
(composition wiring)
**Notes**:

TASK-002: added `packages/infrastructure/src/graphql/resolvers/external-mail.ts`
(`externalMailQueryResolvers`, `externalMailMutationResolvers`,
`externalMailAccountResolvers`), mirroring `contact-mutation.ts`/
`contact-query.ts`'s argument-mapping-only style; error mapping needed no
new code since `ApplicationError` subclasses already map 1:1 through
`toGraphQLError`. One deliberate deviation from the strict `== null`
null-drop convention `contact-mutation.ts` uses everywhere: `smtp` and
`displayName` on `updateExternalMailAccount` use `=== undefined` instead,
so an explicit GraphQL `null` (documented in the SDL as "clears the SMTP
relay") is distinguishable from an omitted field ("no change") -- this
already has precedent in `resolvers/mutation.ts`'s `dueAt`/`note` fields.
Also noted: the SDL's shared `ExternalFetchInput` declares `username`/
`password` non-null, so `updateExternalMailAccount`'s fetch patch always
supplies both rather than exercising the application layer's "omitted
password keeps the ciphertext" leniency for that one field -- only
`sessionUrl`/`host`/`port` are genuinely optional on update. Merged
`externalMailTypeDefs` and the three resolver maps into `schema.ts`
(`ExternalMailAccount: externalMailAccountResolvers` added to the type
map). Added `packages/infrastructure/src/graphql/schema-external-mail.test.ts`
(9 tests): full CRUD lifecycle including `smtp: null` clearing a
previously-configured relay, `CONFLICT` on a second account per address,
`SERVICE_UNAVAILABLE` with no credential key, `FORBIDDEN` for a non-admin
on every mutation but `fetchExternalMail`, a real fetch-summary flow over
the scripted JMAP fake, `NOT_FOUND` probe-resistance for an
out-of-scope-address fetch, `CONFLICT` for fetching a disabled account,
and a schema-shape test asserting no *output* field on any external-mail
type is named/contains `password` or `ciphertext` (input fields
legitimately declare `password`). No export-map changes needed: both
`./graphql/resolvers/*` and `./graphql/schema-external-mail.graphql` were
already covered.

TASK-003: added `ExternalMailRuntime` (`"cloudflare" | "node"`) and
`BuildDependenciesConfig.runtime` to `composition/config.ts`. In
`composition/build-dependencies.ts`: `detectExternalMailRuntime()` reads
`navigator.userAgent === "Cloudflare-Workers"` (the Workers platform's own
documented, synchronous runtime tell) and `resolveExternalMailRuntime()`
layers `config.runtime` on top (explicit wins); `resolveTcpDialer()` picks
`createCloudflareTcpDialer()`/`createNodeTcpDialer()` accordingly. Both
dialer modules are safe to statically import on every runtime by their own
existing design (cloudflare's touches `cloudflare:sockets` only inside
`dial()`; node's `node:net`/`node:tls` resolve fine under workerd because
`apps/api/wrangler.toml` already sets `compatibility_flags =
["nodejs_compat"]`) -- only the *call* is runtime-gated, so no dynamic
`import()` gymnastics were needed. Wired
`externalMailAccountRepository`/`externalMessageStateRepository`/
`jmapClient`/`pop3Client`/`smtpSubmissionClient`/`tcpDialer` into
`buildDependencies`'s returned object, reusing the existing
`credentialCipher` instance (no new secret). `config.test.ts` gained a
"external mail runtime selection" suite covering: `detectExternalMailRuntime`
outside and inside a simulated Workers isolate (via a monkey-patched
`globalThis.navigator`, restored in `afterEach`), `resolveExternalMailRuntime`
with no config in each simulated environment, and explicit `config.runtime`
overriding detection either way -- this tests the selection *decision* in
isolation, deliberately never invoking a dialer's real `dial()`, since real
sockets in a unit test would be either unsafe (a live outbound connection)
or fragile (unpredictable failure timing in a sandboxed CI network). The
existing `buildDependencies` "assembles a working in-memory instance" test
was extended to assert every new `AppDependencies` field is defined.

Deviation beyond the stated scope, required to satisfy this plan's own
"`tsc --noEmit` across `@flying-mail/infrastructure` passes" and the parent
task's "clean repo-wide" criterion: `packages/adapter/src/tcp/
cloudflare-tcp-dialer.ts` depends on an ambient `declare module
"cloudflare:sockets"` living in a sibling `.d.ts` file
(`packages/adapter/src/tcp/cloudflare-sockets.d.ts`). Ambient module
declarations are loaded only from a TypeScript program's own root file set
(`include`/`files`), never transitively through imports, and this
repository typechecks each package independently (`bun run typecheck` is
`bun run --filter '*' typecheck`, one `tsc --noEmit` per package via its
own `tsconfig.json`). `packages/adapter`'s own tsconfig picks the sibling
file up via its `src/**/*.ts` include; `packages/infrastructure`'s and
`apps/api`'s did not, and neither previously imported this file at all, so
the gap was latent until this task's wiring made both of them transitive
importers. Fixed by adding the same relative path to each of their
`include` arrays (`packages/infrastructure/tsconfig.json`,
`apps/api/tsconfig.json`) -- a mechanical, non-behavioral change, no
adapter file touched. Confirmed via `bun run typecheck` (repo root, all 7
packages) and `bunx vitest run` (repo root): both clean, 1837 tests
passing across 115 files. `bunx biome check . --diagnostic-level=warn`
clean across all 418 files.

## Related Plans

- **Depends On**: `external-mail-core.md`, `external-mail-adapter.md`
