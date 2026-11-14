import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "./args";
import { runWatch } from "./commands/watch";
import { CliError, ExitCode } from "./exit-codes";
import type {
  MailEventStream,
  MailEventStreamOptions,
} from "@flying-mail/realtime-client";
import {
  cursorKey,
  readCursor,
  watchCursorsPath,
  writeCursor,
} from "./watch-cursors";

const API_KEY = "ybm_watchprefix_sensitive-secret";
const ENDPOINT = "https://mail.example.test/base";
const DOMAIN_ID = "domain-1";

interface Harness {
  readonly done: Promise<ExitCode>;
  readonly options: MailEventStreamOptions;
  readonly stdout: string[];
  readonly stderr: string[];
  signal(name: "SIGINT" | "SIGTERM"): void;
}

let directory = "";
let env: Record<string, string | undefined>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "flying-mail-watch-"));
  env = { FLYING_MAIL_CONFIG: join(directory, "config.json") };
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

function args(...flags: string[]) {
  return parseArgs([
    "watch",
    "--endpoint",
    ENDPOINT,
    "--api-key",
    API_KEY,
    ...flags,
  ]);
}

async function launch(flags: string[] = []): Promise<Harness> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const listeners = new Map<string, () => void>();
  let options: MailEventStreamOptions | null = null;
  const done = runWatch(args(...flags), env, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    signals: {
      once: (name, listener) => {
        listeners.set(name, listener);
      },
      removeListener: (name, listener) => {
        if (listeners.get(name) === listener) listeners.delete(name);
      },
    },
    streamFactory: (streamOptions): MailEventStream => {
      options = streamOptions;
      return { start: () => {}, stop: () => {} };
    },
  });
  await vi.waitFor(() => expect(options).not.toBeNull());
  const capturedOptions = options;
  if (capturedOptions === null) throw new Error("watch stream was not created");
  return {
    done,
    options: capturedOptions,
    stdout,
    stderr,
    signal: (name) => listeners.get(name)?.(),
  };
}

function stubDomains(domains: readonly { id: string; name: string }[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: { domains } }, { status: 200 })),
  );
}

describe("flying-mail watch", () => {
  it("uses the graphql websocket URL and sends the key in connection params", async () => {
    stubDomains([{ id: DOMAIN_ID, name: "mail.example.test" }]);
    const harness = await launch([
      "--domain",
      "mail.example.test",
      "--address",
      "Team@Example.Test",
    ]);

    expect(harness.options.url).toBe("wss://mail.example.test/graphql");
    expect(harness.options.url).not.toContain(API_KEY);
    expect(harness.options.scope).toEqual({
      domainId: DOMAIN_ID,
      address: "team@example.test",
    });
    expect(harness.options.scope).not.toHaveProperty("types");
    expect(harness.options.connectionParams?.()).toEqual({
      authorization: `Bearer ${API_KEY}`,
    });
    harness.signal("SIGINT");
    expect(await harness.done).toBe(ExitCode.Success);
  });

  it("persists the latest cursor at one-second intervals with mode 0600", async () => {
    vi.useFakeTimers();
    const path = watchCursorsPath(env);
    const key = cursorKey({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      domainId: null,
      address: null,
    });
    expect(key).toBe(`${ENDPOINT}|ybm_watchprefix_***|*|*`);
    await writeCursor(path, key, "epoch.0");
    const harness = await launch();
    expect(harness.options.initialCursor).toBe("epoch.0");
    harness.options.onCursor?.("epoch.1");
    harness.options.onCursor?.("epoch.2");

    expect(key).not.toContain("sensitive-secret");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () =>
      expect(await readCursor(path, key)).toBe("epoch.2"),
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    harness.signal("SIGTERM");
    expect(await harness.done).toBe(ExitCode.Success);
  });

  it("clears the cursor on resync and prints the exact JSON control line", async () => {
    const harness = await launch(["--json"]);
    const path = watchCursorsPath(env);
    const key = cursorKey({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      domainId: null,
      address: null,
    });
    await writeCursor(path, key, "epoch.3");
    harness.options.onCursor?.(null);
    harness.options.onResync?.();
    expect(harness.stdout).toEqual(['{"type":"RESYNC_REQUIRED"}']);
    harness.signal("SIGINT");
    expect(await harness.done).toBe(ExitCode.Success);
    expect(await readCursor(path, key)).toBeNull();
  });

  it("does not resume a cursor saved for a different address", async () => {
    const path = watchCursorsPath(env);
    const key = cursorKey({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      domainId: null,
      address: "first@example.test",
    });
    await writeCursor(path, key, "epoch.4");
    const harness = await launch(["--address", "second@example.test"]);

    expect(harness.options.initialCursor).toBeNull();
    harness.signal("SIGINT");
    expect(await harness.done).toBe(ExitCode.Success);
  });

  it("maps, deduplicates, and sorts short and full event type names", async () => {
    const harness = await launch([
      "--type",
      "sent,received",
      "--type",
      "MESSAGE_RECEIVED",
    ]);
    expect(harness.options.scope).toEqual({
      types: ["MESSAGE_RECEIVED", "MESSAGE_SENT"],
    });
    harness.signal("SIGINT");
    expect(await harness.done).toBe(ExitCode.Success);

    const fullAndShortNames = await launch([
      "--type",
      "SENT",
      "--type",
      "message_received",
    ]);
    expect(fullAndShortNames.options.scope).toEqual({
      types: ["MESSAGE_RECEIVED", "MESSAGE_SENT"],
    });
    fullAndShortNames.signal("SIGINT");
    expect(await fullAndShortNames.done).toBe(ExitCode.Success);

    const draft = await launch(["--type", "draft-saved"]);
    expect(draft.options.scope).toEqual({ types: ["DRAFT_SAVED"] });
    draft.signal("SIGINT");
    expect(await draft.done).toBe(ExitCode.Success);
  });

  it.each(["live", "bogus", "", "constructor"])(
    "rejects invalid type filter %j before making a network call",
    async (type) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const streamFactory = vi.fn(() => ({ start: () => {}, stop: () => {} }));
      await expect(
        runWatch(args("--domain", "mail.example.test", "--type", type), env, {
          streamFactory,
        }),
      ).rejects.toMatchObject({ exitCode: ExitCode.UsageError });
      expect(fetch).not.toHaveBeenCalled();
      expect(streamFactory).not.toHaveBeenCalled();
    },
  );

  it("lists accepted short names for an unknown event type", async () => {
    await expect(
      runWatch(args("--type", "bogus"), env, {
        streamFactory: () => ({ start: () => {}, stop: () => {} }),
      }),
    ).rejects.toThrow(
      "Accepted names: received, sent, updated, deleted, draft-saved, draft-deleted",
    );
  });

  it("rejects an explicitly empty --type= value", async () => {
    await expect(
      runWatch(args("--type="), env, {
        streamFactory: () => ({ start: () => {}, stop: () => {} }),
      }),
    ).rejects.toMatchObject({ exitCode: ExitCode.UsageError });
  });

  it("uses a distinct order-independent cursor key for filtered watches", async () => {
    const path = watchCursorsPath(env);
    const legacyKey = `${ENDPOINT}|ybm_watchprefix_***|*|*`;
    await writeCursor(path, legacyKey, "epoch.legacy");
    const first = await launch(["--type", "sent,received"]);
    expect(first.options.initialCursor).toBeNull();
    const reordered = await launch(["--type", "received,sent"]);
    expect(reordered.options.scope).toEqual(first.options.scope);

    const firstKey = cursorKey({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      domainId: null,
      address: null,
      types: first.options.scope?.types ?? [],
    });
    const reorderedKey = cursorKey({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      domainId: null,
      address: null,
      types: reordered.options.scope?.types ?? [],
    });
    expect(firstKey).toBe(reorderedKey);
    expect(firstKey).toBe(`${legacyKey}|types=MESSAGE_RECEIVED,MESSAGE_SENT`);
    expect(
      cursorKey({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        domainId: null,
        address: null,
        types: ["MESSAGE_SENT"],
      }),
    ).toBe(`${legacyKey}|types=MESSAGE_SENT`);
    first.signal("SIGINT");
    reordered.signal("SIGINT");
    expect(await first.done).toBe(ExitCode.Success);
    expect(await reordered.done).toBe(ExitCode.Success);
  });

  it("prints JSON events and human event lines without exposing the key", async () => {
    const json = await launch(["--json"]);
    const event = {
      cursor: "epoch.1",
      type: "MESSAGE_RECEIVED",
      messageId: "message-1",
      occurredAt: "2026-10-08T00:00:00.000Z",
      addresses: ["user@example.test"],
      message: { subject: "Hello" },
    };
    json.options.onEvent(event);
    expect(JSON.parse(json.stdout[0] ?? "null")).toEqual(event);
    expect([...json.stdout, ...json.stderr].join("\n")).not.toContain(API_KEY);
    json.signal("SIGINT");
    expect(await json.done).toBe(ExitCode.Success);

    const human = await launch();
    human.options.onEvent(event);
    human.options.onEvent({ type: "LIVE", cursor: "epoch.1" });
    expect(human.stdout).toEqual([
      "2026-10-08T00:00:00.000Z MESSAGE_RECEIVED message-1 Hello user@example.test",
    ]);
    expect(human.stderr).toContain("Live at epoch.1");
    expect([...human.stdout, ...human.stderr].join("\n")).not.toContain(
      API_KEY,
    );
    human.signal("SIGINT");
    expect(await human.done).toBe(ExitCode.Success);
  });

  it("maps auth, forbidden, and other fatal failures to the required exit codes", async () => {
    const auth = await launch();
    auth.options.onAuthFailure?.();
    expect(await auth.done).toBe(ExitCode.AuthError);

    const forbidden = await launch();
    forbidden.options.onFatal?.({ code: 4403, reason: "forbidden" });
    expect(await forbidden.done).toBe(ExitCode.ForbiddenError);

    const fatal = await launch();
    fatal.options.onFatal?.({ code: 4400, reason: "bad request" });
    expect(await fatal.done).toBe(ExitCode.GeneralError);
  });

  it("returns usage and not-found codes for missing credentials and unknown domains", async () => {
    await expect(
      runWatch(parseArgs(["watch", "--endpoint", ENDPOINT]), env, {
        streamFactory: () => ({ start: () => {}, stop: () => {} }),
      }),
    ).rejects.toMatchObject({ exitCode: ExitCode.UsageError });

    stubDomains([{ id: DOMAIN_ID, name: "mail.example.test" }]);
    await expect(
      runWatch(args("--domain", "unknown.example.test"), env, {
        streamFactory: () => ({ start: () => {}, stop: () => {} }),
      }),
    ).rejects.toBeInstanceOf(CliError);
    await expect(
      runWatch(args("--domain", "unknown.example.test"), env, {
        streamFactory: () => ({ start: () => {}, stop: () => {} }),
      }),
    ).rejects.toMatchObject({ exitCode: ExitCode.NotFoundError });
  });
});
