# Implementation Plans

This directory contains implementation plans that translate design documents into actionable implementation specifications.

## Purpose

Implementation plans bridge design documents (what to build) and actual code (how to build). They provide:
- Clear deliverables without code
- Interface and function specifications
- Dependency mapping for concurrent execution
- Progress tracking across sessions

## Directory Structure

```
impl-plans/
├── README.md              # This file
├── PROGRESS.json          # Task status index (CRITICAL for impl-exec-auto)
├── <feature>.md           # Implementation plan files (status lives in PROGRESS.json)
└── templates/             # Plan templates
    └── plan-template.md   # Standard plan template
```

## PROGRESS.json (Task Status Index)

**CRITICAL**: `PROGRESS.json` is the central task status index used by `impl-exec-auto`.

Reading all plan files at once causes context overflow (>200K tokens). Instead:
1. `impl-exec-auto` reads only `PROGRESS.json` (~2K tokens)
2. Identifies executable tasks from this index
3. Reads specific plan files only when executing tasks
4. Updates BOTH the plan file AND `PROGRESS.json` after each task

### Structure

```json
{
  "lastUpdated": "2026-01-06T16:00:00Z",
  "phases": {
    "1": { "status": "COMPLETED" },
    "2": { "status": "READY" }
  },
  "plans": {
    "plan-name": {
      "phase": 2,
      "status": "Ready",
      "tasks": {
        "TASK-001": { "status": "Not Started", "parallelizable": true, "deps": [] },
        "TASK-002": { "status": "Completed", "parallelizable": true, "deps": [] }
      }
    }
  }
}
```

### Keeping PROGRESS.json in Sync

After ANY task status change:
1. Edit the task status in `PROGRESS.json`
2. Update `lastUpdated` timestamp
3. Edit the task status in the plan file

## File Size Limits

**IMPORTANT**: Implementation plan files must stay under 400 lines to prevent OOM errors.

| Metric | Limit |
|--------|-------|
| Line count | MAX 400 lines |
| Modules per plan | MAX 8 modules |
| Tasks per plan | MAX 10 tasks |

Large features are split into multiple related plans with cross-references.

## Active Plans

| Plan | Phase | Status | Design Reference |
|------|-------|--------|------------------|
| `domain-model.md` | 1 | Completed | `design-domain-model.md` |
| `app-api-migrations.md` | 1 | Completed | `design-storage-and-file-links.md`, `design-deployment.md` |
| `application-ports-and-policies.md` | 2 | Completed | `design-storage-and-file-links.md`, `design-api-keys-and-permissions.md` |
| `application-usecases-mail.md` | 3 | Completed | `design-mail-pipeline.md` |
| `application-usecases-admin.md` | 3 | Completed | `design-api-keys-and-permissions.md` |
| `adapter-layer.md` | 3 | Completed | `design-storage-and-file-links.md`, `design-mail-pipeline.md` |
| `infrastructure-graphql.md` | 4 | Completed | `design-graphql-api.md` |
| `infrastructure-http.md` | 4 | Completed | `design-graphql-api.md` |
| `app-web-client.md` | 5 | Completed | `design-web-client.md` |
| `app-cli.md` | 5 | Completed | `command.md` |
| `user-mail-permissions.md` | 6 | Completed | `design-user-mail-permissions.md` |
| `remove-calendar.md` | 11 | Completed | Feature retirement change record |

Note: `app-api-migrations.md` is assigned to Phase 1 because its TASK-001
(the D1 schema) has no dependencies and is needed early by the adapter
plan's repository integration tests. Its remaining tasks depend on Phase 4.

## Completed Plans

| Plan | Completed | Design Reference |
|------|-----------|------------------|
| (No completed plans yet) | - | - |

## Phase Dependencies (for impl-exec-auto)

**IMPORTANT**: This section is used by impl-exec-auto to determine which plans to load.
Only plans from eligible phases should be read to minimize context loading.

### Phase Status

| Phase | Status | Depends On |
|-------|--------|------------|
| 1 | COMPLETED | - |
| 2 | COMPLETED | Phase 1 |
| 3 | COMPLETED | Phase 2 |
| 4 | COMPLETED | Phase 3 |
| 5 | COMPLETED | Phase 4 |
| 6 | COMPLETED | Phase 5 |
| 7 | COMPLETED | Phase 6 |
| 8 | COMPLETED | Phase 7 |
| 9 | COMPLETED | Phase 8 |
| 10 | COMPLETED | Phase 9 |
| 11 | COMPLETED | Phase 10 (calendar implementation already completed in phase 7) |

### Phase to Plans Mapping

```
PHASE_TO_PLANS = {
  1: [
    "domain-model.md",
    "app-api-migrations.md",       # TASK-001 only; TASK-002/003 are Phase 4
  ],
  2: [
    "application-ports-and-policies.md",
  ],
  3: [
    "application-usecases-mail.md",
    "application-usecases-admin.md",
    "adapter-layer.md",
  ],
  4: [
    "infrastructure-graphql.md",
    "infrastructure-http.md",
    "app-api-migrations.md",       # TASK-002, TASK-003
  ],
  5: [
    "app-web-client.md",
    "app-cli.md",
  ],
  6: [
    "user-mail-permissions.md",
  ],
  11: [
    "remove-calendar.md",
  ]
}
```

## Workflow

### Creating a New Plan

1. Use the `/impl-plan` command with a design document reference
2. Or manually create a plan using `templates/plan-template.md`
3. Save to `impl-plans/<feature-name>.md`
4. Update this README with the new plan entry
5. **IMPORTANT**: Update `PROGRESS.json` with the new plan and its tasks
6. **IMPORTANT**: If plan exceeds 400 lines, split into multiple files

### Working on a Plan

1. Read `PROGRESS.json` to check task status
2. Read the active plan for task details
3. Select a subtask to work on (consider dependencies)
4. Implement following the deliverable specifications
5. Update task status in BOTH the plan file AND `PROGRESS.json`
6. Mark completion criteria as done

### Completing a Plan

1. Verify all completion criteria are met
2. Update status to "Completed" in both plan and PROGRESS.json
3. Move file from `active/` to `completed/`
4. Update this README
5. Update PROGRESS.json (remove or mark plan as completed)

## Guidelines

- Plans contain NO implementation code
- Plans specify interfaces, functions, and file structures
- Subtasks should be as independent as possible for parallel execution
- Always update progress log after each session
- **Keep each plan file under 400 lines** - split if necessary
- **Always keep PROGRESS.json in sync** with plan file statuses
- [Spam table, mail status, events, rules](completed/spam-table-status-events-rules.md) - Completed 2026-08-23

## Calendar removal (phase 11)

| Plan | Status |
|------|--------|
| [remove-calendar.md](remove-calendar.md) | Completed |

This plan removes the phase-7 calendar and CalDAV feature while preserving
mail, contacts/CardDAV, generic attachments, and shared credential encryption.

Mail templates (`mail-templates.md`) remains **In Progress**: the backend and
the `/settings/templates` catalogue are done, but the web integration listed
at the end of that plan is deferred after the 2026-08-24 checkout incident.

## Contacts and CardDAV (phases 8-10)

| Plan | Status |
|------|--------|
| [contacts-domain.md](contacts-domain.md) | Completed |
| [contacts-application.md](contacts-application.md) | Completed |
| [contacts-adapter.md](contacts-adapter.md) | Completed |
| [contacts-graphql.md](contacts-graphql.md) | Completed |
| [contacts-web.md](contacts-web.md) | Completed |

Design reference: `design-docs/specs/design-contacts.md`.

## External mail accounts: JMAP/POP3 fetch, SMTP relay (phases 8-10)

| Plan | Status |
|------|--------|
| [external-mail-core.md](external-mail-core.md) | Completed |
| [external-mail-adapter.md](external-mail-adapter.md) | Completed |
| [external-mail-graphql.md](external-mail-graphql.md) | Completed |

Design reference: `design-docs/specs/design-external-mail.md`.

- [Flying-mail rename](completed/rename-flying-mail.md) — completed project, repository, and checkout naming.

## Webmail completion (phases 12-15)

Design reference: `design-docs/specs/design-webmail-completion.md`
(accepted 2026-10-07). Plans live in `impl-plans/completed/` (all completed 2026-10-07).

| Wave / Phase | Plan | Depends on |
|--------------|------|------------|
| 1 / 12 | [webmail-01-data-layer](completed/webmail-01-data-layer.md) | - |
| 1 / 12 | [webmail-02-outbound-delivery](completed/webmail-02-outbound-delivery.md) | - |
| 1 / 12 | [webmail-03-web-compose-libs](completed/webmail-03-web-compose-libs.md) | - |
| 1 / 12 | [webmail-04-rest-attachments-limits](completed/webmail-04-rest-attachments-limits.md) | - |
| 1 / 12 | [webmail-05-web-api-contract](completed/webmail-05-web-api-contract.md) | - |
| 2 / 13 | [webmail-06-send-drafts-forward](completed/webmail-06-send-drafts-forward.md) | 01, 02 |
| 2 / 13 | [webmail-07-attachment-deletion](completed/webmail-07-attachment-deletion.md) | 01 |
| 2 / 13 | [webmail-08-ingest-multi-domain](completed/webmail-08-ingest-multi-domain.md) | 01 |
| 2 / 13 | [webmail-09-compose-prefill](completed/webmail-09-compose-prefill.md) | 01, 04 |
| 2 / 13 | [webmail-10-web-compose-ui](completed/webmail-10-web-compose-ui.md) | 03, 05 |
| 3 / 14 | [webmail-11-web-mailbox-ui](completed/webmail-11-web-mailbox-ui.md) | 05, 10 |
| 3 / 14 | [webmail-12-graphql-compose-api](completed/webmail-12-graphql-compose-api.md) | 04, 05, 06, 09 |
| 4 / 15 | [webmail-13-docs-and-final-verification](completed/webmail-13-docs-and-final-verification.md) | all of 01-12 |
| 5 / 16 | [webmail-14-domain-rail-mx](completed/webmail-14-domain-rail-mx.md) | 11 (design section 14) |

Rules for workers:
- Each worker edits only its plan's `writePaths`/`sharedPaths` and its own
  Progress Log.
- Updates to `PROGRESS.json` and to this README are serial reconciliation
  steps, done after each wave joins.
- Workers record file hashes before and after every edit. On drift they
  re-read and merge rather than overwrite.
- A conflict found after a wave joins is repaired serially.
- There are no worktrees and no private branches.

## Authentication hardening (phases 17-21)

Design reference: `design-docs/specs/design-security-model.md` (accepted
2026-10-07). Open user confirmations, with defaults applied, are in
`design-docs/user-qa/pending-auth-hardening.md`. Plans live in
`impl-plans/active/`; plan 09 moves them to `completed/`.

| Wave / Phase | Plan | Depends on |
|--------------|------|------------|
| 1 / 17 | [auth-hardening-01-contracts-and-persistence](completed/auth-hardening-01-contracts-and-persistence.md) | - |
| 1 / 17 | [auth-hardening-02-web-client](completed/auth-hardening-02-web-client.md) | - |
| 1 / 17 | [auth-hardening-03-cli-bootstrap](completed/auth-hardening-03-cli-bootstrap.md) | - |
| 1 / 17 | [auth-hardening-04-docs](completed/auth-hardening-04-docs.md) | - |
| 2 / 18 | [auth-hardening-05-auth-usecases](completed/auth-hardening-05-auth-usecases.md) | 01 |
| 2 / 18 | [auth-hardening-06-adapters](completed/auth-hardening-06-adapters.md) | 01 |
| 3 / 19 | [auth-hardening-07-graphql-http](completed/auth-hardening-07-graphql-http.md) | 01, 02, 05 |
| 4 / 20 | [auth-hardening-08-composition-and-worker](completed/auth-hardening-08-composition-and-worker.md) | 01, 02, 05, 06, 07 |
| 5 / 21 | [auth-hardening-09-final-verification](completed/auth-hardening-09-final-verification.md) | all of 01-08 (serial) |

The same worker rules as for webmail completion apply. Plan 09 alone
updates statuses in `PROGRESS.json` and this table after the final gates
pass.

## Real-time push (phases 22-26)

Design reference: `design-docs/specs/design-realtime-push.md` (accepted
2026-10-08). Open user confirmations, with defaults applied, are in
`design-docs/user-qa/pending-realtime-push.md`. Plans live in
`impl-plans/active/`; plan 11 moves them to `completed/`.

| Wave / Phase | Plan | Depends on |
|--------------|------|------------|
| 1 / 22 | [realtime-push-01-contracts-and-persistence](completed/realtime-push-01-contracts-and-persistence.md) | - |
| 1 / 22 | [realtime-push-02-realtime-client](completed/realtime-push-02-realtime-client.md) | - |
| 1 / 22 | [realtime-push-03-docs](completed/realtime-push-03-docs.md) | - |
| 2 / 23 | [realtime-push-04a-emission-ingest-send-drafts](completed/realtime-push-04a-emission-ingest-send-drafts.md) | 01 |
| 2 / 23 | [realtime-push-04b-emission-message-mutations](completed/realtime-push-04b-emission-message-mutations.md) | 01 |
| 2 / 23 | [realtime-push-05-graphql-surface-and-executor](completed/realtime-push-05-graphql-surface-and-executor.md) | 01 |
| 2 / 23 | [realtime-push-06-web-live-updates](completed/realtime-push-06-web-live-updates.md) | 02 |
| 2 / 23 | [realtime-push-07-cli-watch](completed/realtime-push-07-cli-watch.md) | 02 |
| 3 / 24 | [realtime-push-08-hub-core](completed/realtime-push-08-hub-core.md) | 01, 05 |
| 4 / 25 | [realtime-push-09-worker-durable-object](completed/realtime-push-09-worker-durable-object.md) | 01, 05, 08 |
| 4 / 25 | [realtime-push-10-bun-server](completed/realtime-push-10-bun-server.md) | 01, 05, 08 |
| 5 / 26 | [realtime-push-11-final-verification](completed/realtime-push-11-final-verification.md) | all of 01-10 (serial) |

The same worker rules as for webmail completion apply.

- Plan 02 is the only plan that runs `bun install`, to link the new
  workspace package.
- Plan 11 alone updates statuses in `PROGRESS.json` and this table. It
  edits no source files; gate failures go back to the owning plan.

## USER_ADMIN capability and event-type filter (phases 27-29)

Design reference: `design-docs/specs/design-user-admin-capability.md`
(accepted 2026-10-08), plus the `MailEventScope.types` sections of
`design-docs/specs/design-realtime-push.md`. Open user confirmations, with
defaults applied, are in `design-docs/user-qa/pending-user-admin.md`.
Plans live in `impl-plans/active/`; plan 08 moves them to `completed/`.

| Wave / Phase | Plan | Depends on |
|--------------|------|------------|
| 1 / 27 | [user-admin-01-capability-contract](completed/user-admin-01-capability-contract.md) | - |
| 1 / 27 | [user-admin-02-realtime-type-filter](completed/user-admin-02-realtime-type-filter.md) | - |
| 1 / 27 | [user-admin-03-cli-watch-type](completed/user-admin-03-cli-watch-type.md) | - |
| 1 / 27 | [user-admin-04-web-api-keys](completed/user-admin-04-web-api-keys.md) | - |
| 1 / 27 | [user-admin-05-cli-user-commands](completed/user-admin-05-cli-user-commands.md) | - |
| 1 / 27 | [user-admin-06-readme-docs](completed/user-admin-06-readme-docs.md) | - |
| 2 / 28 | [user-admin-07-authorization](completed/user-admin-07-authorization.md) | 01 |
| 3 / 29 | [user-admin-08-final-verification](completed/user-admin-08-final-verification.md) | all of 01-07 (serial) |

The same worker rules as for webmail completion apply.

- Plan 05 alone edits `apps/cli/src/main.ts`, including the `watch
  --type` HELP line on behalf of plan 03.
- Plan 06 is documentation-only and declares explicit document checks.
- Plan 08 alone runs `mise run build-web` (artifact root `apps/web/dist`)
  and the Worker dry run (artifact root `apps/api/.wrangler`). It is also
  the only plan that updates statuses in `PROGRESS.json` and this table.

## Remote MCP server (phases 30-33)

Design reference: `design-docs/specs/design-mcp-server.md` (accepted
2026-10-08). Open user confirmations, with defaults applied, are in
`design-docs/user-qa/pending-mcp-server.md`. Plans live in
`impl-plans/active/`; plan 12 moves them to `completed/`.

| Wave / Phase | Plan | Depends on |
|--------------|------|------------|
| 1 / 30 | [mcp-server-01-application-usecases](active/mcp-server-01-application-usecases.md) | - |
| 1 / 30 | [mcp-server-02-content-shaping](active/mcp-server-02-content-shaping.md) | - |
| 1 / 30 | [mcp-server-03-protocol-core](active/mcp-server-03-protocol-core.md) | - |
| 1 / 30 | [mcp-server-04-docs](active/mcp-server-04-docs.md) | - |
| 2 / 31 | [mcp-server-05-read-tools](active/mcp-server-05-read-tools.md) | 02, 03 |
| 2 / 31 | [mcp-server-06-compose-tools](active/mcp-server-06-compose-tools.md) | 02, 03 |
| 2 / 31 | [mcp-server-07-attachment-tools](active/mcp-server-07-attachment-tools.md) | 01, 02, 03 |
| 2 / 31 | [mcp-server-08-manage-tools](active/mcp-server-08-manage-tools.md) | 01, 03 |
| 2 / 31 | [mcp-server-09-user-admin-tools](active/mcp-server-09-user-admin-tools.md) | 03 |
| 2 / 31 | [mcp-server-10-transport-wiring](active/mcp-server-10-transport-wiring.md) | 01, 02, 03 |
| 3 / 32 | [mcp-server-11-catalogue-integration](active/mcp-server-11-catalogue-integration.md) | 05-10 |
| 4 / 33 | [mcp-server-12-final-verification](active/mcp-server-12-final-verification.md) | all of 01-11 (serial) |

The same worker rules as for webmail completion apply.

- Plan 02 alone edits `packages/infrastructure/package.json` and runs
  `bun install`. Its artifact roots are `node_modules` and
  `packages/infrastructure/node_modules`.
- Plan 03 creates the five empty tool-group stubs in
  `packages/infrastructure/src/mcp/tools/`. In wave 2, each stub is owned
  by exactly one plan (05-09).
- Plan 04 is documentation-only and declares explicit document checks.
- Plan 11 is tests-only. Product defects go back to the owning plan.
- Plan 12 alone runs `mise run build-web` (artifact root `apps/web/dist`)
  and the Worker dry run (artifact root `apps/api/.wrangler`). It is the
  only plan that updates statuses in `PROGRESS.json` and this table.

- [Login page clarity](active/login-page-clarity.md): clarify login purpose and passwordless guidance.
