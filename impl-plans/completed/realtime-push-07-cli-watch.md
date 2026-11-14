# Realtime Push 07: CLI `flying-mail watch`

**Status**: Completed
**Plan ID**: realtime-push-07-cli-watch
**Wave**: 2 (phase 23)
**Depends On**: realtime-push-02-realtime-client
**Design Reference**: design-docs/specs/design-realtime-push.md section 10.4; design-docs/specs/command.md "watch"
**Created**: 2026-10-08

## Intent and context

Add the reference API client:

```
flying-mail watch [--domain <name|id>] [--address <addr>] [--json]
```

- It streams `mailEvents` through `createMailEventStream`, from
  `@flying-mail/realtime-client` (plan 02).
- It sends the API key only in `connection_init`.
- It persists the cursor per endpoint, key prefix and scope.
- It reconnects forever on network errors.

## Non-goals

- Do not edit `apps/cli/package.json` (plan 02), `commands/index.ts` (715
  lines; keep it untouched), `client-serve.ts` or the existing `mail fetch
  --watch`.
- No API key in the URL, argv echo or logs.
- No new global flags.

## writePaths

- apps/cli/src/commands/watch.ts (new)
- apps/cli/src/watch-cursors.ts (new)
- apps/cli/src/watch.test.ts (new)
- apps/cli/src/main.ts
- impl-plans/completed/realtime-push-07-cli-watch.md (progress log only)

sharedPaths: none.

## File-level changes

### `watch-cursors.ts`

- `watchCursorsPath(env): string` is
  `join(dirname(configFilePath(env)), "watch-cursors.json")`, reusing
  `config.ts:configFilePath`.
- `cursorKey({ endpoint, apiKey, domainId, address })`:
  - Format: `` `${endpoint}|${keyPrefix}|${domainId ?? "*"}|${address ?? "*"}` ``.
  - `keyPrefix` is the `ybm_<prefix>` part, as derived by `maskApiKey` in
    `config.ts:84`. **Never** put the secret part in the key.
- `readCursor(path, key)` and `writeCursor(path, key, cursor | null)`:
  - The file is a JSON object.
  - Writes are atomic: write a temp file, then rename.
  - Mode `0600`, applied with `chmod` like `writeConfigFile` (config.ts:50).
  - `null` deletes the entry.
  - A missing or corrupt file reads as `{}`.

### `commands/watch.ts`

`runWatch(args, env, deps?: { streamFactory?, now?, stdout?, stderr?, signals? }): Promise<ExitCode>`

1. Resolve the config with `resolveConfig`. Without an endpoint or API key,
   fail with `CliError` exit 2 and the same message style as the other
   commands (see `requireEndpoint` in `client.ts:21`).
2. `--domain`: if the value is not an existing domain id, resolve it by
   name through the existing GraphQL client `domains` query
   (`createCliClient`). An unknown name exits 5. `--address` is lower-cased.
3. Build the URL: endpoint `https:` becomes `wss:`, `http:` becomes `ws:`,
   with path `/graphql`.
4. Create the stream:
   - `connectionParams: () => ({ authorization: "Bearer " + apiKey })`
   - `scope` from the flags
   - `initialCursor` from the cursor file
   - Query: `cursor type messageId domainId addresses occurredAt message { subject from { address } }`
5. Output.
   - Human mode: one stdout line per non-LIVE event:
     `${occurredAt} ${type} ${messageId} ${subject ?? "-"} ${addresses.join(",")}`.
   - LIVE and resync notices go to stderr.
   - `--json` mode: NDJSON on stdout, one `JSON.stringify(event)` per event
     including LIVE. On resync, the line `{"type":"RESYNC_REQUIRED"}`.
6. **Cursor persistence.** `onCursor` keeps the latest value in memory and
   flushes at most once per second (trailing timer). It also flushes on
   exit. `null` deletes the entry.
7. **Termination.** The promise resolves on:
   - SIGINT or SIGTERM: `stop()`, flush, exit 0;
   - `onAuthFailure`: exit 3 (`ExitCode.AuthError`);
   - `onFatal` with code 4403: exit 4 (`ExitCode.ForbiddenError`);
   - any other fatal: exit 1.

   Network errors never resolve it. Use `process.once`, as `runClientServe`
   does in `main.ts:124-131`.

### `main.ts`

- Route `watch`, like `client serve`: handle it before `COMMAND_GROUPS`,
  because it is long-running.
- Add HELP lines:

  ```
  watch [--domain] [--address] [--json]
      Stream mail events (WebSocket subscription)
  ```

## Pitfalls

- `--json` is a global boolean flag. Check how `args.ts` treats `json`;
  do not add a new flag type.
- The cursor file sits next to the config file. Under `FLYING_MAIL_CONFIG`
  it moves with it.
- Never print the API key. A test asserts that stdout and stderr do not
  contain the secret.
- Ensure the flush timer cannot keep the process alive after exit (clear it
  on stop).

## Tests (`watch.test.ts`; a fake stream factory, fake timers, a temp config dir)

- An `https://h` endpoint -> URL `wss://h/graphql`.
- `connectionParams()` -> `{ authorization: "Bearer ybm_..." }`, and the URL
  contains no key.
- A stored cursor for the same endpoint, key and scope -> passed as
  `initialCursor`. A different `--address` -> null.
- Events `e.1`, `e.2` -> the file holds `e.2` after 1 s. The file mode is
  `0600`. The key string contains no secret part.
- The resync callback -> the entry is removed, and `--json` prints
  `{"type":"RESYNC_REQUIRED"}`.
- `--json` -> NDJSON lines that parse with `JSON.parse`. Human mode -> the
  expected line format.
- `onAuthFailure` -> exit 3. A fatal 4403 -> exit 4. A fatal 4400 -> exit 1.
  A simulated SIGINT -> exit 0, and the cursor is flushed.
- Missing API key -> exit 2.
- Unknown `--domain` name (the fake GraphQL client returns no match) ->
  exit 5.
- stdout and stderr never contain the key secret.

## Verification (repo root)

1. `bunx vitest run apps/cli`: exit 0. Existing CLI tests are unchanged.
2. `bun run --cwd apps/cli typecheck`: exit 0.
3. `bunx biome check apps/cli/src`: exit 0.
4. `wc -l apps/cli/src/main.ts apps/cli/src/commands/watch.ts`: every file
   is under 1000 lines.

## Done criteria

- [x] `flying-mail watch` behaves as specified.
- [x] Verification steps 1-4 pass, with outputs recorded.

## Progress Log

### Session: 2026-10-08
**Tasks Completed**: `flying-mail watch` implementation and assigned verification
**Blockers**: None
**Notes**:
- Added `apps/cli/src/commands/watch.ts`, `apps/cli/src/watch-cursors.ts`, and `apps/cli/src/watch.test.ts`; routed top-level `watch` in `apps/cli/src/main.ts` and added help text.
- Implemented API-key auth through synchronous `connection_init` params, domain id/name resolution, lower-cased address scope, WebSocket URL construction, human/NDJSON output, cursor resync and persistence, signal handling, and required exit codes.
- Cursor storage is adjacent to the CLI config, keyed with the masked API-key prefix and scope, atomically replaced, and chmodded to `0600`.
- Final source hashes: `apps/cli/src/main.ts` `046dba2a37776b10d6aa8bc775b9efa63fa3d39e66dcbf4004aa40c8608d97b5`; `apps/cli/src/commands/watch.ts` `2d066181276d09e95c2564a90210341afddcba905820e99ce0d5808b4fccd719`; `apps/cli/src/watch-cursors.ts` `436fc14df995682445b35238971b505cd69b759f70a4bf85084e610ceed1d925`; `apps/cli/src/watch.test.ts` `28c0abd6d1abbeae0cda151e6c34038c8d1d5e49ebb94bb315c89e57d772e1e7`.
- Final verification: `bunx vitest run apps/cli` passed 108/108 tests (exit 0); `bun run --cwd apps/cli typecheck` exit 0; `bunx biome check apps/cli/src` exit 0; `wc -l apps/cli/src/main.ts apps/cli/src/commands/watch.ts` reported 232 and 252 lines (exit 0). Complete logs and source hashes are under `tmp/realtime-push-s306/realtime-push-07-cli-watch/attempt-1/final-3/`.
- Earlier typecheck and Biome attempts failed and were corrected; final-2 identified one additional formatting issue, fixed before final-3. The initial test wrapper also failed after the suite passed because zsh reserves `$status`. The source-matched final-3 reruns supersede those attempts; original logs remain under `tmp/realtime-push-s306/realtime-push-07-cli-watch/attempt-1/`.
- Formal independent review and combined-tree integration gates remain assigned to downstream workflow steps.

### Session: 2026-10-08 orchestrator completion
The riela workflow accepted plans 01, 02, 04a, 04b, 05 and 07; its progress gate blocked 03 (docs-only, no test count), 06 (build-web output root not declared) and 08 (non-JSON worker output). The orchestrator continued with GPT-6 Luna and read-only Opus reviews: 03 APPROVED (notes fixed); 06 CHANGES_REQUESTED (H1 stale refresh, M1 boundary row, M2 bounded 4401 retry, M3 open-message patching, L1-L2) fixed; 08 CHANGES_REQUESTED twice (H1 revoked principal drain stall, H2 serial frames, M3 single state source, M4 cap races, L5-L8; then D1 ghost state, D2 unhandled rejections, D3 fail-open init limiter, D4 reservations) fixed; 09 and 10 CHANGES_REQUESTED (orphaned conn storage, accept/open failure, tag-based socket lookup, alarm/stub error handling, hibernation resume test; Bun end-to-end next test, handler error containment) fixed. Final gate: mise run lint exit 0; bun run test 2002 package + 299 web tests; build-web and Worker dry run exit 0. Deployed (migration 0016, MailEventHub Durable Object) to https://mail.tacoserve.online and verified live with the CLI watch client over wss: LIVE marker, real-time MESSAGE_SENT/MESSAGE_RECEIVED across domains, disconnect then offline send then resume from the persisted cursor replayed exactly the missed events (no duplicates) before LIVE; invalid key rejected; upgrade without subprotocol 400, cookie with foreign Origin 403, valid upgrade 101.
