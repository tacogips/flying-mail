# Design Notes

Research findings and decisions that do not belong in the architecture or
command specs.

## Why Cloudflare Email Routing for inbound

Email Routing can deliver a message to a Worker's `email()` handler, giving a
`ForwardableEmailMessage` with `from`, `to` (the SMTP envelope recipient),
`headers`, `raw` (a `ReadableStream` of the MIME source), `rawSize`, plus
`forward()`, `reply()` and `setReject()`. That is enough to build a real
mailbox without running an SMTP server, which is the whole premise of this
project. `setReject()` matters specifically: rejecting unknown recipients at
SMTP time is what keeps a catch-all deployment from becoming a spam sink.

## MIME parsing: `postal-mime`

Chosen over `mailparser` and hand-rolling. `mailparser` depends on Node
streams and does not run on Workers; `postal-mime` is written for browsers and
serverless runtimes, has no dependencies, parses attachments into
`ArrayBuffer`s, and has built-in guards against deeply nested parts and
oversized headers -- all of which matter when the input is attacker-supplied.
It is wrapped behind a `MimeParser` port so this choice stays replaceable and
the application layer stays testable with canned parse results.

## MIME building: `mimetext`

Used only when a raw RFC 5322 source must be produced -- storing an outbound
message's `.eml` in R2, and any send path that needs custom headers. The
structured `env.EMAIL.send({ from, to, subject, text, html })` form is
preferred for the actual delivery because it avoids a whole class of header
injection bugs.

## Sending constraints

Cloudflare's send binding caps a message at 50 recipients, 32 attachments and
5 MiB total, and requires a verified sender domain (`E_SENDER_NOT_VERIFIED`
otherwise). Recipients that previously bounced or reported spam are
suppressed. These are validated before the binding call so callers get a
`BAD_USER_INPUT` naming the offending field instead of an opaque provider
error.

## Why per-API-key fetch state rather than a global flag

A single `fetched` boolean on the message breaks the moment two agents share a
mailbox: whichever polls first marks the message consumed for everyone. Making
the state a `(message, api_key)` pair costs one small table and makes each
consumer's progress independent, which is what "manage fetched/not-fetched
status per API" actually needs to mean for agent workloads. Rows are written
only on acknowledgment, so the table tracks acknowledged work rather than the
Cartesian product of messages and keys.

## Why no Durable Objects

The reference implementation `cloudflare/agentic-inbox` uses one Durable
Object per mailbox, each with its own SQLite database. That is a good fit for a
single-user AI inbox with heavy per-mailbox agent state. mailcal's requirements
pull the other way: cross-domain and cross-mailbox queries (an agent scoped to
`*@example.com`, a tag view spanning every mailbox, global API key
administration) are first-class, and those are awkward to serve when the data
is sharded per mailbox. A single D1 database keeps every listing a plain
indexed query. Durable Objects remain the right answer if per-mailbox
write throughput ever becomes the bottleneck.

## Address matching is a small custom glob, not a regex

Letting operators supply regexes for API key scopes would be a footgun
(catastrophic backtracking on attacker-influenced addresses, and patterns that
are hard to reason about when auditing a key). The `AddressPattern` grammar
allows at most one `*` in the local part, which covers every realistic scope
(`*`, `*@domain`, `exact@domain`, `prefix-*@domain`) and is matched in linear
time.

## Storing recipients in their own table

A JSON column would be simpler to write but makes "every message delivered to
`support@example.com`" a full scan -- which is both the mailbox listing query
and the API key scope filter, i.e. the two hottest paths. A row per recipient
with an index on `(address, message_id)` makes both indexed lookups. The
`ENVELOPE` kind is stored separately from `TO`, because BCC'd and aliased mail
legitimately has an envelope recipient absent from the headers, and it is the
envelope recipient that authorization must match.

## References

See `design-docs/references/README.md`.
