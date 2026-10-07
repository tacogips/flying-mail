# Flying-mail Rename Implementation Plan

**Status**: Completed
**Design Reference**: [Project rename](../../design-docs/specs/notes.md#project-rename-to-flying-mail)
**Created**: 2026-10-07
**Last Updated**: 2026-10-07

## Scope and Modules

Rename project metadata, workspace imports, CLI and UI branding, documentation,
GitHub repository, Git remote, and checkout directory. Existing operational
configuration and storage names remain compatible. No new interfaces are needed.

### TASK-001: Rename project metadata and code
**Status**: Completed
**Parallelizable**: No
**Dependencies**: None
**Deliverables**: Workspace manifests, lockfile, TypeScript imports and branding, README and design documents.

**Completion Criteria**:
- [x] Project and workspace names use flying-mail
- [x] CLI and UI show flying-mail
- [x] Legacy operational configuration remains compatible

### TASK-002: Verify rename
**Status**: Completed
**Parallelizable**: No
**Dependencies**: TASK-001
**Deliverables**: Lint, typecheck, tests, build results.

**Completion Criteria**:
- [x] Checks pass and dependency versions remain unchanged

### TASK-003: Rename repository and checkout
**Status**: Completed
**Parallelizable**: No
**Dependencies**: TASK-002
**Deliverables**: GitHub flying-mail repository, updated origin, flying-mail checkout directory.

**Completion Criteria**:
- [x] GitHub name and remote verified
- [x] Local directory renamed and Git remains usable

## Module Status

| Module | Status |
|---|---|
| Metadata and code | Completed |
| Verification | Completed |
| Repository and checkout | Completed |

## Completion Criteria

- [x] All three tasks complete

## Progress Log

### Session: 2026-10-07
Scope inspected; working tree clean and GitHub admin permission confirmed.

Completed: metadata, workspace imports, CLI/UI branding and documentation renamed.
Biome, all workspace typechecks, production build, and 1,771 tests passed;
follow-up CLI checks and 94 CLI tests passed after one remaining command message
was corrected. Lockfile versions unchanged. GitHub repository and origin renamed;
checkout moved to flying-mail and Git/CLI verified from the new directory.
Existing deployment/configuration/storage identifiers preserved. No commit or push made.
