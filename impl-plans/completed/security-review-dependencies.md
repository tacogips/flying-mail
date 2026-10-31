# Dependency Security Review

**Status**: Completed
**Design Reference**: design-docs/specs/design-security-model.md
**Created**: 2026-10-28

## Scope and deliverables

Resolve the three vulnerable dependency families confirmed by `bun audit`:
Vitest mock tooling, Vite development server, and Undici HTTP clients.
Count each dependency family once, rather than counting duplicate advisories
across installed versions. Preserve each Undici major version.

Deliverables: root and web package manifests and the Bun lockfile.

## Tasks

### TASK-001: Update affected versions
**Status**: Completed
**Parallelizable**: Yes
- [x] Pin patched Vitest and Vite releases.
- [x] Scope patched Undici versions to their existing major versions.
- [x] Install with lifecycle scripts disabled and retain release-age protection.

### TASK-002: Verify
**Status**: Completed
**Parallelizable**: No (depends on TASK-001)
- [x] Dependency audit reports no known vulnerabilities.
- [x] Frozen lockfile install succeeds.
- [x] Lint, type checks, test suites and builds pass.

## Progress Log

2026-10-28: Initial audit confirmed three affected dependency families. Verified
patched versions against registry metadata and published security advisories.

2026-10-28: Independent integrated verification passed: lint and formatting, all
8 workspace typechecks, 2792 tests across 211 files, production web build,
frozen lockfile install, clean dependency audit (309 packages), and diff checks.
