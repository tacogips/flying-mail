---
name: lib-replacement
description: Use when auditing codebase for custom implementations that can be replaced with well-known libraries. Provides replacement patterns, audit checklist, and migration strategies.
allowed-tools: Read, Glob, Grep
---

# Library Replacement Skill

This skill provides guidelines for finding redundant custom implementations and replacing them with well-known libraries.

## Purpose

Identify custom implementations that:
- Duplicate functionality available in well-known libraries
- Are harder to maintain than library equivalents
- May have bugs that libraries have already solved
- Lack the testing/documentation of established libraries

## When to Apply

Apply this skill when:
- Auditing codebase for technical debt
- Refactoring for maintainability
- Reducing custom code footprint
- Standardizing on ecosystem best practices

## Common Replacement Patterns

### Pattern Categories

| Category | Custom Implementation Signs | Recommended Libraries |
|----------|----------------------------|----------------------|
| Result/Error Handling | Custom Result type, ok/err pattern | `neverthrow`, `ts-results`, `effect` |
| Validation | Custom validate functions, manual checks | `zod`, `valibot`, `arktype` |
| Date/Time | Custom date parsing/formatting | `date-fns`, `dayjs`, `luxon` |
| Path Operations | Custom path manipulation | `pathe`, `upath` (cross-platform) |
| CLI Parsing | Custom argument parsing | `commander`, `yargs`, `citty` |
| Configuration | Custom config loading | `c12`, `cosmiconfig`, `rc9` |
| Logging | Custom logger implementations | `pino`, `consola`, `winston` |
| HTTP Client | Custom fetch wrappers | `ofetch`, `ky`, `got` |
| Retry Logic | Custom retry loops | `p-retry`, `async-retry` |
| Debounce/Throttle | Custom implementations | `lodash-es` (specific imports), `perfect-debounce` |
| Deep Clone/Merge | Custom recursive functions | `klona`, `defu`, `deepmerge-ts` |
| Type Guards | Repetitive type checks | `typeguard`, `ts-is` |
| UUID/ID Generation | Custom ID generators | `nanoid`, `ulid`, `uuid` |
| Hashing | Custom hash implementations | `ohash`, `hash-sum` |
| File Watching | Custom fs.watch wrappers | `chokidar`, `watchlist` |
| Glob Patterns | Custom glob matching | `tinyglobby`, `fast-glob`, `picomatch` |
| JSON Parsing | Custom streaming JSON | `@streamparser/json`, `stream-json` |
| JSONL/NDJSON | Custom line-by-line parsing | `ndjson`, `jsonlines` |
| String Utils | Custom case conversion, trim | `scule`, `change-case` |
| Async Utilities | Custom promise helpers | `p-*` packages (p-limit, p-map, p-queue) |
| Schema Generation | Custom type-to-schema | `typebox`, `zod-to-json-schema` |
| Diff/Patch | Custom diff algorithms | `diff`, `fast-diff`, `json-diff` |
| Template Strings | Custom template parsing | `handlebars`, `mustache`, `eta` |
| Caching | Custom cache implementations | `lru-cache`, `quick-lru`, `keyv` |
| Rate Limiting | Custom rate limiters | `p-throttle`, `limiter`, `bottleneck` |

### Bun-Specific Considerations

Bun provides built-in alternatives for some patterns:

| Pattern | Bun Built-in | External Library |
|---------|--------------|------------------|
| Glob | `Bun.glob()` | Not needed |
| File I/O | `Bun.file()`, `Bun.write()` | Not needed |
| Hashing | `Bun.hash()`, `Bun.CryptoHasher` | Not needed |
| SQLite | `bun:sqlite` | Not needed |
| Test Runner | `bun:test` | Not needed |
| Shell Commands | `Bun.spawn()`, `Bun.$` | Not needed |

## Audit Checklist

When auditing code, look for:

### 1. Utility Functions (High Priority)

```typescript
// RED FLAG: Custom implementations of common utilities
function deepClone(obj) { ... }
function debounce(fn, delay) { ... }
function retry(fn, maxAttempts) { ... }
function generateId() { return Math.random()... }
```

### 2. Error Handling Patterns (High Priority)

```typescript
// RED FLAG: Custom Result type
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// BETTER: Use neverthrow
import { Result, ok, err } from 'neverthrow';
```

### 3. Validation Logic (Medium Priority)

```typescript
// RED FLAG: Manual validation
function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// BETTER: Use zod
const emailSchema = z.string().email();
```

### 4. Date/Time Operations (Medium Priority)

```typescript
// RED FLAG: Custom date formatting
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  ...
}

// BETTER: Use date-fns
import { format } from 'date-fns';
format(date, 'yyyy-MM-dd');
```

### 5. Async Patterns (Medium Priority)

```typescript
// RED FLAG: Custom promise utilities
async function promisePool(tasks, concurrency) { ... }
async function withTimeout(promise, ms) { ... }

// BETTER: Use p-* packages
import pLimit from 'p-limit';
import pTimeout from 'p-timeout';
```

## Replacement Strategy

### Phase 1: Audit

1. Scan for custom utility functions
2. Identify patterns matching library functionality
3. Assess replacement difficulty
4. Prioritize by impact and risk

### Phase 2: Plan

For each replacement:
1. Identify all usages of custom implementation
2. Select appropriate library
3. Plan migration approach (big bang vs incremental)
4. Identify test coverage requirements

### Phase 3: Replace (Concurrent Execution)

Parallelizable replacements (no shared dependencies):
- Different utility functions in separate files
- Independent module replacements

Sequential replacements (shared dependencies):
- Core types used across modules
- Shared validation schemas

### Phase 4: Verify

1. Run type checking
2. Run all tests
3. Review changes
4. Verify no regressions

## Difficulty Assessment

### Easy Replacements

- Drop-in function replacement
- Same or compatible API
- No type changes needed
- Example: `generateId()` -> `nanoid()`

### Medium Replacements

- API differences require minor refactoring
- Some type adjustments needed
- Limited scope of changes
- Example: Custom validation -> Zod schemas

### Hard Replacements

- Significant API differences
- Type system changes
- Wide usage across codebase
- Example: Custom Result type -> neverthrow

## Testing Considerations

### Before Replacement

- Ensure existing tests pass
- Identify test coverage gaps
- Document expected behavior

### During Replacement

- Keep tests passing incrementally
- Add tests for edge cases
- Verify library handles all cases

### After Replacement

- Full test suite must pass
- Add integration tests if needed
- Performance comparison if relevant

## References

- [neverthrow - Type-Safe Errors](https://github.com/supermacro/neverthrow)
- [zod - TypeScript-first schema validation](https://zod.dev/)
- [date-fns - Modern date utility library](https://date-fns.org/)
- [Sindre Sorhus's p-* packages](https://github.com/sindresorhus?tab=repositories&q=p-)
- [unjs packages](https://unjs.io/) - High-quality JS utilities
