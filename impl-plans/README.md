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
| 6 | READY | Phase 5 |

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

## Calendar and CalDAV (phase 7)

| Plan | Status |
|------|--------|
| [calendar-domain.md](calendar-domain.md) | Completed |
| [calendar-application.md](calendar-application.md) | Completed |
| [calendar-adapter.md](calendar-adapter.md) | Completed |
| [calendar-graphql.md](calendar-graphql.md) | Completed |
| [calendar-web.md](calendar-web.md) | Completed |

Design reference: `design-docs/specs/design-calendar.md`.

Mail templates (`mail-templates.md`) remains **In Progress**: the backend and
the `/settings/templates` catalogue are done, but the web integration listed
at the end of that plan is deferred after the 2026-08-24 checkout incident.
