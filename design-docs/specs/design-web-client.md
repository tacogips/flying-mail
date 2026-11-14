# Web Mail Client

`apps/web` is a SolidJS single-page mail client built with Vite. It is a plain
consumer of the same `/graphql` endpoint agents use -- it has no privileged
API of its own -- and is served two ways:

1. Bundled into the Worker as static assets (`[assets] binding = "ASSETS"`),
   so a deployment is self-contained at `https://<worker-host>/`.
2. Locally by `mailcal client serve`, which serves the built bundle and proxies
   `/graphql`, `/api` and `/files` to a configured remote endpoint. See
   `command.md`.

## Stack

| Concern | Choice |
|---------|--------|
| Framework | `solid-js` |
| Routing | `@solidjs/router` |
| GraphQL | a ~250-line `fetch` wrapper; no Apollo/urql |
| HTML mail rendering | `dompurify` sanitize into a sandboxed iframe |
| Styling | Plain CSS with design tokens; one `.css` file per component |

State lives in a single `AppStore` built from Solid signals and stores,
created once in `app.tsx` and read through a context, mirroring the reference
project's `store/app-store.ts` split into `-documents` and `-helpers` files to
keep each under the 1000-line limit.

## Routes

| Path | Guard | View |
|------|-------|------|
| `/login` | public | Passwordless email request |
| `/auth/verify` | public | Consumes the emailed token, establishes the session |
| `/` | auth | Mailbox: message list for the selected domain/address |
| `/threads/:id` | auth | Thread view with per-message expansion |
| `/messages/:id` | auth | Single message detail |
| `/compose` | auth | Compose / reply |
| `/search` | auth | Filter-driven search results |
| `/settings/domains` | admin | Domain list, add, DNS records, verify |
| `/settings/api-keys` | admin | Key list, issue with a scope builder, revoke |
| `/settings/users` | admin | User list, roles, activation, address/domain permissions |
| `/settings/tags` | auth | User tag management |

## Key components

| Component | Responsibility |
|-----------|----------------|
| `app-shell` | Sidebar + topbar + routed outlet |
| `mailbox-sidebar` | Domains, addresses, system tags (Inbox/Starred/Spam/Trash), user tags |
| `message-list` | Virtualized keyset-paginated list; multi-select for bulk actions |
| `message-view` | Headers, body, attachment tiles, tag chips, spam banner |
| `html-body-frame` | Sanitized HTML rendered in a `sandbox`ed iframe; remote images blocked until the reader opts in |
| `compose-form` | From-address picker (scoped), recipients, subject, body, attachment upload |
| `tag-picker` | Add/remove tags, create a new tag inline |
| `attachment-tile` | Download, or "copy temp link" via `createAttachmentLink` |
| `domain-form` / `dns-record-table` | Add a domain and show the records to publish |
| `api-key-form` / `scope-builder` | Capability + domain + address-pattern rows; shows the secret once, with a copy button and an explicit "you will not see this again" warning |
| `user-permission-editor` | Role selector plus allow/deny domain and exact-address assignments |
| `spam-banner` | "Marked as spam (score 0.82)" with a one-click **Not spam** |

## Search syntax

The search box speaks a small operator syntax (`lib/search-query.ts`), so a
single input covers every filter dimension without a filter-builder UI:

| Operator | Meaning |
|----------|---------|
| `from:addr` | Sender |
| `to:addr` | Recipient, cc **not** included |
| `cc:addr` / `recipient:addr` | Recipient, cc/bcc included |
| `has:attachment` / `no:attachment` | Attachment presence |
| `kind:pdf` / `kind:pdf,image` | Attachment kind, repeatable |
| `tag:Name` / `tag:"With Spaces"` | Tag by name, resolved client-side |
| `is:unread` | Unread only |
| `in:spam` | Include spam explicitly |
| anything else | Full text over subject, snippet and body |

Unknown operators and unresolved tag names fall back to free text rather
than erroring: a search box that rejects input is worse than one that
searches for it.

## Behaviors worth stating

- **HTML mail is hostile input.** Bodies are sanitized with DOMPurify *and*
  rendered inside a `sandbox` iframe with no `allow-same-origin`, so even a
  sanitizer bypass cannot reach the session cookie. Remote images are stripped
  until the reader clicks "load images", which prevents tracking pixels from
  firing on open.
- **Spam is hidden by default** in every list except the Spam view, matching
  the API's `includeSpam: false` default.
- **The secret is shown once.** `createApiKey` returns it in the mutation
  response; the client holds it in a signal that is cleared on navigation and
  never written to `localStorage`.
- **Compose respects scope.** The from-address picker is populated from the
  viewer's `MAIL_SEND` scopes, so a scoped user cannot compose a send that the
  server will reject.
- **Optimistic tagging.** Tag and read/unread toggles update the store
  immediately and roll back on error with a toast, because those mutations are
  frequent and individually cheap.
