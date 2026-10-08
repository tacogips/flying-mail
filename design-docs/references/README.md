# Design References

This directory contains reference materials for system design and implementation.

## External References

| Name | URL | Description |
|------|-----|-------------|
| Cloudflare Email Workers runtime API | https://developers.cloudflare.com/email-routing/email-workers/runtime-api/ | `email()` handler and `ForwardableEmailMessage` (`from`, `to`, `raw`, `setReject`, `forward`, `reply`) |
| Cloudflare Email Routing | https://developers.cloudflare.com/email-routing/ | Inbound routing rules, catch-all delivery to a Worker |
| Send email from Workers | https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/ | `send_email` binding, `EmailMessage`, sender verification, limits |
| Cloudflare Email Service Workers API | https://developers.cloudflare.com/email-service/api/route-emails/email-handler/ | Structured `env.EMAIL.send({...})` form |
| Cloudflare D1 | https://developers.cloudflare.com/d1/ | SQL store; `batch()` atomicity, no interactive transactions |
| Cloudflare R2 | https://developers.cloudflare.com/r2/ | Object store for raw MIME and attachment bodies |
| Workers Static Assets | https://developers.cloudflare.com/workers/static-assets/ | `[assets]` binding serving the SolidJS SPA |
| cloudflare/agentic-inbox | https://github.com/cloudflare/agentic-inbox | Reference self-hosted AI inbox on Workers (Durable Objects per mailbox, R2 attachments, Workers AI) |
| Self-hosted email client on Workers (write-up) | https://daily.dev/posts/a-self-hosted-email-client-with-an-ai-agent-running-entirely-on-cloudflare-workers-47ogdez9b | Narrative overview of the agentic-inbox design |
| postal-mime | https://github.com/postalsys/postal-mime | MIME parser for browsers and serverless runtimes; used for inbound parsing |
| postal-mime on Cloudflare Workers | https://postal-mime.postalsys.com/docs/guides/cloudflare-workers/ | Parsing `message.raw` inside an Email Worker |
| mimetext | https://github.com/muratgozel/MIMEText | RFC 5322 message builder used for stored `.eml` sources |
| graphql-yoga | https://the-guild.dev/graphql/yoga-server | Fetch-native GraphQL server used on Workers |
| hono | https://hono.dev/ | HTTP router shared by the Workers, Bun and Node targets |
| SolidJS | https://www.solidjs.com/docs | Web mail client framework |
| Solid Router | https://docs.solidjs.com/solid-router | Routing for the mail client |
| DOMPurify | https://github.com/cure53/DOMPurify | HTML mail sanitization |
| RFC 5322 | https://www.rfc-editor.org/rfc/rfc5322 | Internet Message Format: headers, `Message-ID`, `In-Reply-To`, `References` |
| RFC 5987 | https://www.rfc-editor.org/rfc/rfc5987 | `Content-Disposition` `filename*` encoding for downloads |
| RFC 6350 | https://www.rfc-editor.org/rfc/rfc6350 | vCard 4.0 format (contacts model and codec) |
| RFC 2426 | https://www.rfc-editor.org/rfc/rfc2426 | vCard 3.0 (iCloud's wire format; codec output) |
| RFC 6352 | https://www.rfc-editor.org/rfc/rfc6352 | CardDAV: addressbook-query, multiget, ctag sync |
| RFC 6764 | https://www.rfc-editor.org/rfc/rfc6764 | Locating CalDAV/CardDAV services (well-known discovery) |
| RFC 8620 | https://www.rfc-editor.org/rfc/rfc8620 | JMAP core: session resource, method calls, blob download |
| RFC 8621 | https://www.rfc-editor.org/rfc/rfc8621 | JMAP for Mail: Mailbox/Email objects and queries |
| RFC 1939 | https://www.rfc-editor.org/rfc/rfc1939 | POP3: UIDL/RETR fetch protocol |
| RFC 5321 | https://www.rfc-editor.org/rfc/rfc5321 | SMTP protocol (relay client) |
| RFC 6409 | https://www.rfc-editor.org/rfc/rfc6409 | Message submission (port 587) |
| RFC 8314 | https://www.rfc-editor.org/rfc/rfc8314 | Implicit TLS for mail protocols (465/995 posture) |
| Cloudflare TCP sockets | https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/ | `cloudflare:sockets` `connect()`, `startTls`, outbound port 25 block |
| TypeScript Documentation | https://www.typescriptlang.org/docs/ | Official TypeScript documentation |
| Bun Documentation | https://bun.sh/docs | Official Bun runtime documentation |
| graphql-transport-ws protocol | https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md | Subprotocol messages and close codes implemented by the subscription server and client (design-realtime-push.md) |
| Durable Objects WebSocket Hibernation | https://developers.cloudflare.com/durable-objects/best-practices/websockets/ | `acceptWebSocket`, `serializeAttachment`, `setWebSocketAutoResponse`, hibernation handlers |
| Durable Objects migrations | https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ | `[[migrations]]`, `new_sqlite_classes`, renamed/deleted classes |
| Bun WebSockets | https://bun.sh/docs/api/websockets | `Bun.serve` `websocket` handler and `server.upgrade` used by the local server |
| CSP Level 3 source matching | https://www.w3.org/TR/CSP3/#match-url-to-source-expression | `'self'` matching same-host `ws:`/`wss:` for `connect-src` |

## Internal reference

The sibling project `xxip` (`/Users/taco/gits/tacogips/xxip`) is the
architectural template for this repository: the same four-package clean
architecture (`domain` / `application` / `adapter` / `infrastructure`), the
same `SqlDatabase`/`BlobStore` port shapes, the same hono + graphql-yoga
composition, and the same Workers/Bun/Node triple-target deployment.

## Reference Documents

Reference documents should be organized by topic:

```
references/
├── README.md              # This index file
└── <topic>/               # Topic-specific references
```

## Adding References

When adding new reference materials:

1. Create a topic directory if it does not exist
2. Add reference documents with clear naming
3. Update this README.md with the reference entry
