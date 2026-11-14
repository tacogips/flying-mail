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
| TypeScript Documentation | https://www.typescriptlang.org/docs/ | Official TypeScript documentation |
| Bun Documentation | https://bun.sh/docs | Official Bun runtime documentation |

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
