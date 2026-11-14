# Pending: real-time push decisions

Design: `design-docs/specs/design-realtime-push.md`. Each item below already
has a default **applied** in the design. Implementation is not blocked. Each
item is waiting for user confirmation and can be changed later.

## R1. One Durable Object for all sockets

- **Applied default:** a single `MailEventHub` instance
  (`idFromName("mail-events")`). Every poke costs one D1 page read for all
  subscribers. Sharding by principal hash is documented as the scaling path
  but not built.
- Alternative: shard now, at the cost of writers poking every shard and a
  more complex test matrix.

## R2. Event retention

- **Applied default:** 7 days (`FLYING_MAIL_EVENT_RETENTION_SECONDS =
  604800`), configurable in `[3600, 2592000]`. Pruning runs on every
  append; there is no cron.
- Alternative: a shorter default to keep the table small, or a cron trigger.

## R3. Connection limits

- **Applied defaults:**
  - Connection attempts: 10 per 60 s per IP (`ws:connect:<ip>`).
  - `connection_init`: 10 per 60 s per principal (`ws:init:<kind>:<id>`).
    Both reuse the `AUTH_RATE_LIMITER` binding.
  - 20 concurrent sockets per IP, 10 per principal, 1000 per hub.
  - 4 subscriptions per socket.
  - 16 KiB frames.
  - 10 s `connection_init` timeout.
  - 75 s idle timeout, with clients pinging every 25 s.
- Alternative: a dedicated rate-limit binding with different numbers (needs
  a new `namespace_id`).

## R4. Event append is not atomic with the mail write

- **Applied default:** the event batch runs right after the use case's last
  state write. If it fails, the error is logged and the mutation still
  succeeds. Live clients miss that one update until their next catch-up.
  API consumers keep the lossless `fetchStatus` path.
- Alternative: thread event statements into every repository write batch.
  That is a much larger change, and several mutations are already multi-step
  today.

## R5. No WebSocket through `flying-mail client serve` or the Node runtime

- **Applied default:** both are out of scope.
  - The web client shows "Offline" under `client serve` and otherwise works
    as before.
  - The Node runtime answers upgrades with 501.
- Alternative: add WebSocket proxying to `client serve` as a follow-up.

## R6. Hand-written client instead of the `graphql-ws` npm package

- **Applied default:** a zero-dependency `@flying-mail/realtime-client`
  workspace package used by the web client and the CLI. The stock
  `graphql-ws` client remains supported for third parties, with `keepAlive`
  set.
- Alternative: depend on `graphql-ws`. That brings a peer-range mismatch
  with `graphql@17`, stale-cursor resubscribe on retry, and wrapping needed
  for `RESYNC_REQUIRED` and `LIVE`.

## R7. Changes that emit no event

- **Applied default:** no events for:
  - fetch-state acknowledgements,
  - tag catalogue changes (`createTag`, `renameTag`, `deleteTag`),
  - cascading deletes from domain or mailbox deletion.

  Clients converge on their next catch-up.
- Alternative: add tag-catalogue events.
