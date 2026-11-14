# Implementation Plan: Spam Table, Mail Status, Message Events, Classification Rules

**Status**: Completed
**Design Reference**: design-docs/specs/design-domain-model.md#spam-as-a-verdict-table-mail-status-events-mailing-lists-and-rules-2026-08-23

## Summary

Implemented in one session (2026-08-23), all layers, deployed as worker
version 62385180 with migration 0004 applied to the remote D1.

- TASK-001 message_spam table + SpamMark entity + markSpam/markNotSpam
  rewrite + spamOnly/includeSpam filters + backfill migration: Done
- TASK-002 messages.status (DRAFT/SENT/RECEIVED) + saveDraft/sendDraft +
  Drafts folder + CLI --status: Done
- TASK-003 message_events table + MessageEvent entity + CRUD use cases +
  GraphQL surface + web event panel + agenda query: Done
- TASK-004 mailing-list detection (List-Id et al -> messages.list_id /
  is_mailing_list) + classification_rules table + rule evaluation at
  ingest + GraphQL CRUD + /settings/rules page: Done

## Progress Log

### Session: 2026-08-23
All tasks completed. 1028 tests passing across workspaces; Biome clean;
strict typecheck clean. Migration 0004 applied remotely; deployed and
verified via schema introspection (MailStatus/MessageEvent/
ClassificationRule types live, SystemTagSlug no longer carries SPAM).
