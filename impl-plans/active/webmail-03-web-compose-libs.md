# Webmail 03: Web Compose Libraries (sanitizer, plain-text derivation, autosave, upload)

**Status**: Ready
**planId**: webmail-03-web-compose-libs
**Wave**: 1 (no dependencies)
**Design Reference**: design-docs/specs/design-webmail-completion.md section 7 (Compose: compose sanitizer, HTML vs plain, Attachments, Autosave), D6, D7
**Created**: 2026-10-07

## Intent and context

The compose UI (webmail-10) needs three framework-free, unit-tested
libraries. Building them first lets the UI plan focus on components.

The web app is SolidJS + Vite under `apps/web`, tested with vitest + jsdom
(`apps/web/vitest.config.ts`). DOMPurify is already a dependency and is
used in `apps/web/src/lib/mail-html.ts`; imitate its import and hook style.

## Non-goals

- No components.
- No GraphQL operations.
- No changes to `mail-html.ts` (the received-mail sanitizer stays as is).
- No new npm dependencies.

## Shared rules (all webmail plans)

- English only, no emojis. Never run git commit, stash, reset, checkout or
  push. Preserve the 251 uncommitted rename changes.
- No deploy, no remote wrangler.
- Re-read each file before editing it, and record its sha256 before and
  after in the Progress Log. If it drifted, re-read and merge.
- Edit only `writePaths`.
- Update only this plan's checkboxes and Progress Log. Never edit
  `impl-plans/PROGRESS.json` or `impl-plans/README.md`.

## Write ownership

**writePaths**
- `apps/web/src/lib/compose-html.ts`
- `apps/web/src/lib/compose-html.test.ts`
- `apps/web/src/lib/draft-autosave.ts`
- `apps/web/src/lib/draft-autosave.test.ts`
- `apps/web/src/lib/upload.ts`
- `apps/web/src/lib/upload.test.ts`
- `impl-plans/active/webmail-03-web-compose-libs.md` (checkboxes and Progress Log only)

**sharedPaths**: none.

## File-level changes

### apps/web/src/lib/compose-html.ts (new, + compose-html.test.ts)

```ts
export function sanitizeComposeHtml(html: string): string;
export function htmlToPlainText(html: string): string;
export function plainTextToHtml(text: string): string;
export function isAllowedLinkUrl(url: string): boolean; // http:, https:, mailto: only (case-insensitive, trimmed)
```

**`sanitizeComposeHtml`**
- Use a DOMPurify config separate from `mail-html.ts`. Do not import or
  mutate that module's hooks or config.
  - Pitfall: DOMPurify hooks are global. Add a hook only inside a
    function that removes it again (`DOMPurify.removeHook`) in a
    `try/finally`. Better still, do the work as a post-pass on the
    returned DOM fragment (`RETURN_DOM_FRAGMENT`) with no hooks at all.
- Allowed tags: `p div br span b strong i em u s ul ol li a blockquote pre code hr table thead tbody tr td th img`.
- Allowed attributes: `href title alt colspan rowspan dir src`.
  - `src` is kept only on `img` and only when it starts with
    `data:image/`. Any other img (remote or `cid:`) is replaced by a text
    node holding its alt text, or by nothing when it has no alt.
  - `href` is kept only when `isAllowedLinkUrl(href)`. Otherwise the link
    is unwrapped and its text kept.
- Must remove: `<style>` elements, and `style`, `class` and `id`
  attributes, plus every `on*` attribute.

**`htmlToPlainText`**
- Parse with `DOMParser`.
- Block elements (`p div li blockquote pre table tr h1-h6` and `br`)
  produce line breaks.
- `ul > li` becomes `- item` and `ol > li` becomes `n. item`.
- Each line inside a blockquote is prefixed `> `, and nesting stacks.
- `a` becomes `text <href>`, or just the text when text equals href.
- Decode entities. Collapse 3+ blank lines to 2. Trim the trailing
  whitespace.

**`plainTextToHtml`**
- HTML-escape `& < > " '`.
- Blank-line-separated paragraphs become `<p>`, and single newlines become
  `<br>`.

### apps/web/src/lib/draft-autosave.ts (new, + draft-autosave.test.ts)

```ts
export type DraftSaveOutcome = { readonly kind: "saved" } | { readonly kind: "conflict" } | { readonly kind: "error"; readonly message: string };
export type DraftSaverState = "idle" | "pending" | "saving" | "saved" | "error" | "conflict" | "disposed";
export interface DraftSaver<T> {
  notifyChange(content: T): void;   // (re)starts the debounce timer
  flush(): Promise<void>;           // cancels the timer, saves now if dirty, awaits any in-flight save
  cancel(): Promise<void>;          // cancels the timer, awaits in-flight, does NOT start a new save
  dispose(): void;                  // after this every call is a no-op and late results are ignored
  state(): DraftSaverState;
}
export function createDraftSaver<T>(options: {
  readonly save: (content: T) => Promise<DraftSaveOutcome>;
  readonly isSame: (a: T, b: T) => boolean;
  readonly debounceMs: number;       // the UI passes 2000
  readonly onStateChange?: (state: DraftSaverState) => void;
}): DraftSaver<T>;
```

Rules a careless implementation gets wrong:
- At most one save is in flight. Changes during a save are queued as the
  single latest pending content and saved after it completes.
- Content equal (`isSame`) to the last successfully saved snapshot is not
  saved.
- A `conflict` outcome sets state `conflict` and stops all future saves.
- The saver never sends or delivers anything. It only calls `save`.
- Use `setTimeout`/`clearTimeout` so tests can use
  `vi.useFakeTimers()`.

### apps/web/src/lib/upload.ts (new, + upload.test.ts)

```ts
export interface UploadedAttachmentInfo { readonly id: string; readonly fileName: string; readonly contentType: string; readonly size: number }
export type UploadFailure = "TOO_LARGE" | "UNAUTHENTICATED" | "NETWORK" | "SERVER" | "ABORTED";
export type UploadResult = { readonly ok: true; readonly attachment: UploadedAttachmentInfo } | { readonly ok: false; readonly failure: UploadFailure; readonly message: string; readonly maxBytes?: number };
export function uploadAttachmentWithProgress(file: File, onProgress: (loaded: number, total: number) => void, options?: { readonly endpoint?: string; readonly createXhr?: () => XMLHttpRequest }): { readonly promise: Promise<UploadResult>; abort(): void };
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<readonly R[]>;
```

**Request**
- `POST` to `options.endpoint ?? "/api/attachments"` with
  `withCredentials = true` (same-origin cookie).
- The body is `FormData` with field `file`, matching the existing
  `uploadAttachment` in `apps/web/src/api/graphql-client.ts:277-312`.
- Progress comes from `xhr.upload.onprogress`.

**Responses**
- 201 -> parse the JSON `{id, fileName, contentType, size}`.
- 413 -> `TOO_LARGE`, with `maxBytes` taken from the body field `maxBytes`
  when present. Server contract from webmail-04:
  `{error, code:"PAYLOAD_TOO_LARGE", maxBytes}`.
- 401 -> `UNAUTHENTICATED`.
- Any other non-2xx -> `SERVER`, using the body's `error` string when
  present.
- `onerror` -> `NETWORK`.
- `abort()` -> `ABORTED`.

**`mapWithConcurrency`**
- Preserves input order in the result.
- Never runs more than `limit` at once.

## Tests (input -> expected)

**compose-html**
- `<p style="color:red" class="x" onclick="a()">Hi</p>` -> `<p>Hi</p>`.
- `<style>body{}</style><b>x</b>` -> `<b>x</b>`.
- `<img src="https://t/p.gif" alt="logo">` -> text `logo` and no `img`.
- `<img src="cid:abc">` -> removed.
- `<img src="data:image/png;base64,AA==">` -> kept.
- `<a href="javascript:alert(1)">x</a>` -> `x` with no anchor.
- `<a href="https://e.com">e</a>` -> kept.
- `<script>alert(1)</script>ok` -> `ok`.
- htmlToPlainText of `<ul><li>a</li><li>b</li></ul>` -> `- a\n- b`.
- htmlToPlainText of `<ol><li>a</li></ol>` -> `1. a`.
- htmlToPlainText of `<blockquote><p>q</p></blockquote>` -> `> q`.
- htmlToPlainText of `<a href="https://e.com">site</a>` ->
  `site <https://e.com>`.
- plainTextToHtml of `a<b\n\nc` -> `<p>a&lt;b</p><p>c</p>`.
- isAllowedLinkUrl of ` MAILTO:x@y ` -> true; `data:text/html,..` ->
  false.

**draft-autosave** (fake timers)
- Three changes within 2 s -> exactly one save, with the last content.
- A change while saving -> a second save after the first resolves, with
  the latest content.
- Same content as the last saved -> no save.
- `flush()` saves immediately and resolves after completion.
- A conflict outcome -> state `conflict`, and later changes trigger no
  save.
- After `dispose()`, a pending timer does not save, and a late resolution
  does not change state.

**upload** (fake XHR via `createXhr`)
- 201 -> ok with the parsed info.
- Progress events -> `onProgress` called with loaded/total.
- 413 with `{maxBytes:5242880}` -> TOO_LARGE, maxBytes 5242880.
- 401 -> UNAUTHENTICATED.
- abort -> ABORTED.
- `mapWithConcurrency` with limit 3 over 7 items -> max concurrency
  observed is 3, and order is preserved.

## Invariants

- No module here imports SolidJS or performs a GraphQL call.

## Verification (repo root; log exit codes)

- `bun run --cwd apps/web test -- src/lib/compose-html.test.ts src/lib/draft-autosave.test.ts src/lib/upload.test.ts`
  -> exit 0.
- `bun run --cwd apps/web typecheck` -> exit 0.
- `bunx biome check apps/web/src/lib/compose-html.ts apps/web/src/lib/compose-html.test.ts apps/web/src/lib/draft-autosave.ts apps/web/src/lib/draft-autosave.test.ts apps/web/src/lib/upload.ts apps/web/src/lib/upload.test.ts --diagnostic-level=warn`
  -> no diagnostics.

## Completion criteria

- [ ] Three modules with the exact exported signatures above.
- [ ] All listed tests pass.
- [ ] Typecheck and Biome are clean.

## Progress Log

### Session: (not started)
**Tasks Completed**: None
