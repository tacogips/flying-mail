# Client security review fixes

**Status**: Completed
**Design Reference**: design-docs/specs/design-web-client.md (Security posture), design-docs/specs/design-security-model.md
**Created**: 2026-10-28

## Deliverables

- CLI endpoint loopback validation accepts only real loopback addresses, never similarly prefixed DNS names.
- Mail frame remote-image consent is scoped to the selected message identity.
- Regression tests exercise both boundaries.
- Realtime connection parameters are requested only once a socket opens, with rejection handling attached immediately.

## Tasks

### TASK-001: Loopback validation
**Parallelizable**: Yes
- [x] Validate IPv4 literals before classifying the 127/8 range.
- [x] Verify endpoint rejection and proxy binding rejection for deceptive hostnames.

### TASK-002: Message image consent
**Parallelizable**: Yes
- [x] Associate image consent with message identity.
- [x] Verify changing messages, including identical bodies, blocks images again.

### TASK-003: Verification
**Parallelizable**: No
- [x] Relevant tests, Biome and typecheck pass.

### TASK-004: Realtime credential failure handling
**Parallelizable**: Yes
- [x] Defer connection parameter acquisition until socket open and test throwing/rejecting providers and connection failure.

## Progress Log

- 2026-10-28: Reviewed client rendering, CLI transport/proxy, credential configuration and realtime transport. Confirmed loopback-prefix bypass and remote-image consent surviving message changes; implementing targeted corrections.

- 2026-10-28: Completed three distinct fixes. CLI/realtime suites: 220 passing tests; web suite: 334 passing tests. Workspace typecheck passed; final realtime typecheck and Biome on all seven changed TypeScript files passed. Parent performs final integrated verification.
