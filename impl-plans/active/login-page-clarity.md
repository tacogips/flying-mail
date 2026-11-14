# Login Page Clarity Implementation Plan

**Status**: In Progress
**Design Reference**: [Login page clarity](../../design-docs/specs/design-web-client.md#login-page-clarity)
**Created**: 2026-10-08
**Last Updated**: 2026-10-08

## Scope and Deliverables

Clarify the purpose of `/login` through visible headings, explanatory copy,
accessible field guidance, and a clear email confirmation state. Preserve
existing authentication behavior. No dependencies or deployment changes.

Existing component signature: `LoginPage(): JSX.Element`.

### TASK-001: Clarify login page

**Status**: In Progress
**Parallelizable**: No
**Dependencies**: None
**Deliverables**: `apps/web/src/pages/login-page.tsx`, `apps/web/src/pages/login-page.css`

**Completion Criteria**:
- [x] Product name, explicit login heading, and mailbox purpose are visible.
- [x] Passwordless flow and account email guidance are clear and accessible.
- [x] Confirmation heading and existing account-private wording are preserved.
- [x] Existing login tests, web typecheck, Biome, and web build pass.
- [ ] Layout is verified at mobile and desktop widths.

## Module Status

| Module | Status | Validation |
|--------|--------|------------|
| Login page and styling | In Progress | 302 web tests pass; rendered visual check pending |

## Progress Log

### Session: 2026-10-08
Plan created from the user request and the web client design specification.

### Session: 2026-10-08 — Implementation and verification
**Tasks In Progress**: TASK-001 (implementation complete; rendered visual check pending)
**Review Iterations**: 1
**Review Summary**: Static TypeScript/DOM/CSS review approved. Authentication,
Turnstile callbacks, validation, and account privacy remain unchanged. Existing
tests cover the login behavior; no string-only tests or coverage run were added
for this copy/layout change.
**Validation**:
- Independent check-and-test-after-modify: scoped Biome passes, web typecheck
  passes, all 302 web tests across 27 files pass, and `mise run build-web` passes.
- After the final CSS-only narrow-screen correction, scoped formatting/Biome
  and `mise run build-web` pass again. Biome excludes CSS in the repository
  configuration; CSS received static review and Vite build validation.
- At a 320px viewport the card is 304px wide; the verification wrapper uses
  negative inline margins to provide 302px for the fixed 300px widget while
  retaining text padding. Desktop card width is capped at 420px.
**Remaining Criterion**: Rendered mobile/desktop layout could not be verified:
no browser surface is available, and selecting Safari timed out. Static
responsive review is complete; the visual checkbox remains pending.
**Notes**: No deployment, commits, dependencies, or unrelated source edits.
