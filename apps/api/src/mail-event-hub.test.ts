import { createInMemoryDatabase } from "@flying-mail/adapter/sql/libsql";
import { createMigrationRunner } from "@flying-mail/adapter/migrations/runner";
import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
} from "@flying-mail/adapter/sql/d1";
import type {
  DurableObjectStateLike,
  HibernatableWebSocketLike,
} from "./durable-object-types";
import { MailEventHub, type HubRuntime } from "./mail-event-hub";
import { buildDependencies } from "@flying-mail/infrastructure/composition/build-dependencies";
import { buildWorkerConfig } from "./worker-config";
import type {
  PreparedSubscription,
  SubscriptionExecutor,
} from "@flying-mail/infrastructure/realtime/executor";
import type { Env } from "./env";
import type { ConnectionState } from "@flying-mail/infrastructure/realtime/host";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
const TEST_EXECUTOR: SubscriptionExecutor = {
  prepare: () => ({
    ok: true,
    prepared: {
      scope: { domainId: null, address: null },
      after: null,
    } as PreparedSubscription,
  }),
  async execute(_prepared, payload) {
    return {
      data: {
        mailEvents: { cursor: payload.cursor, type: payload.type },
      },
    };
  },
};

function d1OverLibsql(db: SqlDatabase): D1DatabaseLike {
  return {
    prepare(sql) {
      let params: readonly unknown[] = [];
      const statement: D1PreparedStatementLike = {
        bind(...values) {
          params = values;
          return statement;
        },
        async all<T>() {
          return { results: await db.query<T>(sql, params as never) };
        },
        async run() {
          const result = await db.execute(sql, params as never);
          return { meta: { changes: result.rowsAffected } };
        },
      };
      Object.defineProperty(statement, "__sql", {
        value: () => ({ sql, params }),
      });
      return statement;
    },
    async batch<T>(statements: readonly D1PreparedStatementLike[]) {
      await db.batch(
        statements.map((statement) => {
          const stored = statement as unknown as {
            __sql(): { sql: string; params: readonly unknown[] };
          };
          return { ...stored.__sql(), params: stored.__sql().params as never };
        }),
      );
      return statements.map(() => ({ results: [] as readonly T[] }));
    },
  };
}

class FakeSocket implements HibernatableWebSocketLike {
  attachment: unknown = null;
  readonly sent: string[] = [];
  readonly closed: { code: number; reason: string }[] = [];
  send(message: string): void {
    this.sent.push(message);
  }
  close(code = 1000, reason = ""): void {
    this.closed.push({ code, reason });
  }
  serializeAttachment(attachment: unknown): void {
    this.attachment = attachment;
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

class FakeState implements DurableObjectStateLike {
  readonly storageValues = new Map<string, unknown>();
  readonly sockets: HibernatableWebSocketLike[] = [];
  readonly accepted: {
    socket: HibernatableWebSocketLike;
    tags: string[] | undefined;
  }[] = [];
  autoResponse: unknown;
  alarmAt: number | null = null;
  async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }
  acceptWebSocket(socket: HibernatableWebSocketLike, tags?: string[]): void {
    this.sockets.push(socket);
    this.accepted.push({ socket, tags });
  }
  getWebSockets(tag?: string): HibernatableWebSocketLike[] {
    return this.sockets.filter(
      (socket) =>
        tag === undefined ||
        this.accepted
          .find((accepted) => accepted.socket === socket)
          ?.tags?.includes(tag) === true,
    );
  }
  setWebSocketAutoResponse(pair: unknown): void {
    this.autoResponse = pair;
  }
  getWebSocketAutoResponseTimestamp(): Date | null {
    return null;
  }
  storage = {
    get: async <T>(key: string): Promise<T | undefined> =>
      this.storageValues.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      this.storageValues.set(key, value);
    },
    delete: async (key: string): Promise<boolean> =>
      this.storageValues.delete(key),
    list: async <T>(options: {
      readonly prefix: string;
    }): Promise<Map<string, T>> =>
      new Map(
        [...this.storageValues].filter(([key]) =>
          key.startsWith(options.prefix),
        ) as [string, T][],
      ),
    setAlarm: async (milliseconds: number): Promise<void> => {
      this.alarmAt = milliseconds;
    },
    deleteAlarm: async (): Promise<void> => {
      this.alarmAt = null;
    },
  };
}

async function makeEnv(): Promise<Env> {
  const db = createInMemoryDatabase();
  await createMigrationRunner(db).apply(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => ({
        name,
        sql: readFileSync(join(MIGRATIONS_DIR, name), "utf-8"),
      })),
  );
  return {
    DB: d1OverLibsql(db),
    BLOB: {
      async put() {},
      async get() {
        return null;
      },
      async delete() {},
    },
    EMAIL: {
      async send() {
        return {};
      },
    },
    ASSETS: {
      async fetch() {
        return new Response();
      },
    },
    FLYING_MAIL_PUBLIC_ORIGIN: "https://mail.example.com",
  };
}

function runtime(pair?: {
  client: FakeSocket;
  server: FakeSocket;
}): HubRuntime & {
  readonly calls: HibernatableWebSocketLike[];
  readonly auto: unknown[][];
} {
  const sockets = pair ?? {
    client: new FakeSocket(),
    server: new FakeSocket(),
  };
  const calls: HibernatableWebSocketLike[] = [];
  const auto: unknown[][] = [];
  return {
    calls,
    auto,
    createAutoResponsePair(request, response) {
      auto.push([request, response]);
      return { request, response };
    },
    createSocketPair: () => sockets,
    createUpgradeResponse(client) {
      calls.push(client);
      return new Response("upgraded", { status: 200 });
    },
  };
}

async function connect(
  hub: MailEventHub,
  ip = "203.0.113.9",
): Promise<Response> {
  return hub.fetch(
    new Request("https://mail-event-hub.internal/connect", {
      headers: { upgrade: "websocket", "x-flying-mail-client-ip": ip },
    }),
  );
}

describe("MailEventHub Durable Object", () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("registers the exact ping auto-response and persists an accepted connection", async () => {
    const ctx = new FakeState();
    const pair = { client: new FakeSocket(), server: new FakeSocket() };
    const fake = runtime(pair);
    const hub = new MailEventHub(ctx, env, fake);
    expect(fake.auto).toEqual([['{"type":"ping"}', '{"type":"pong"}']]);
    const response = await connect(hub);
    expect(await response.text()).toBe("upgraded");
    expect(fake.calls).toEqual([pair.client]);
    expect(ctx.sockets).toEqual([pair.server]);
    const connId = (pair.server.attachment as { readonly connId: string })
      .connId;
    expect(ctx.accepted).toEqual([
      { socket: pair.server, tags: ["ip:203.0.113.9", `conn:${connId}`] },
    ]);
    expect(pair.server.attachment).toEqual({ connId: expect.any(String) });
    expect(
      ctx.storageValues.has(
        `conn:${(pair.server.attachment as { connId: string }).connId}`,
      ),
    ).toBe(true);
    expect(ctx.alarmAt).not.toBeNull();
  });

  test("limits the 21st live connection from one IP", async () => {
    const ctx = new FakeState();
    const hub = new MailEventHub(ctx, env, runtime());
    const responses: Response[] = [];
    for (let index = 0; index < 21; index += 1)
      responses.push(await connect(hub));
    expect(
      responses.slice(0, 20).every((response) => response.status === 200),
    ).toBe(true);
    expect(responses[20]?.status).toBe(429);
  });

  test("/notify drains and returns 204; unknown paths return 404", async () => {
    const hub = new MailEventHub(new FakeState(), env, runtime());
    expect(
      (await hub.fetch(new Request("https://mail-event-hub.internal/nope")))
        .status,
    ).toBe(404);
    expect(
      (
        await hub.fetch(
          new Request("https://mail-event-hub.internal/notify", {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(204);
  });

  test("/notify delivers an appended event to an acknowledged subscription", async () => {
    const ctx = new FakeState();
    const pair = { client: new FakeSocket(), server: new FakeSocket() };
    const hub = new MailEventHub(ctx, env, runtime(pair), {
      executor: TEST_EXECUTOR,
    });
    const built = buildDependencies(buildWorkerConfig(env));
    const tokenHash = await built.tokenHasher.hash("test-api-key");
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO api_keys
      (id, name, key_hash, key_prefix, created_by_user_id, created_at, last_used_at, expires_at, revoked_at)
      VALUES ('key-notify', 'test', ?, 'test-prefix', NULL, ?, NULL, NULL, NULL)`)
      .bind(tokenHash, now)
      .run();
    await env.DB.prepare(`INSERT INTO api_key_scopes
      (id, api_key_id, capability, domain_id, address_pattern)
      VALUES ('scope-notify', 'key-notify', 'MAIL_READ', NULL, '*')`).run();
    await connect(hub);
    await hub.webSocketMessage(
      pair.server,
      JSON.stringify({
        type: "connection_init",
        payload: { authorization: "Bearer test-api-key" },
      }),
    );
    await hub.webSocketMessage(
      pair.server,
      JSON.stringify({
        type: "subscribe",
        id: "sub-1",
        payload: {
          query:
            "subscription ($scope: MailEventScope, $after: String) { mailEvents(scope: $scope, after: $after) { cursor type } }",
        },
      }),
    );
    expect(pair.server.sent.join("\n")).toContain("connection_ack");
    await env.DB.prepare(`INSERT INTO mail_events
      (type, message_id, domain_id, addresses, occurred_at)
      VALUES ('MESSAGE_UPDATED', 'message-1', 'domain-1', '["reader@example.com"]', ?)`)
      .bind(now)
      .run();
    const response = await hub.fetch(
      new Request("https://mail-event-hub.internal/notify", { method: "POST" }),
    );
    expect(response.status).toBe(204);
    expect(pair.server.sent.join("\n")).toContain('"type":"next"');
    expect(pair.server.sent.join("\n")).toContain("MESSAGE_UPDATED");
  });

  test("rehydrates a socket after hibernation and handles its next message", async () => {
    const ctx = new FakeState();
    const pair = { client: new FakeSocket(), server: new FakeSocket() };
    const first = new MailEventHub(ctx, env, runtime(pair), {
      executor: TEST_EXECUTOR,
    });
    await connect(first);
    const connId = (pair.server.attachment as { readonly connId: string })
      .connId;
    const built = buildDependencies(buildWorkerConfig(env));
    const tokenHash = await built.tokenHasher.hash("test-api-key");
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO api_keys
      (id, name, key_hash, key_prefix, created_by_user_id, created_at, last_used_at, expires_at, revoked_at)
      VALUES ('key-rehydrate', 'test', ?, 'test-prefix', NULL, ?, NULL, NULL, NULL)`)
      .bind(tokenHash, now)
      .run();
    await env.DB.prepare(`INSERT INTO api_key_scopes
      (id, api_key_id, capability, domain_id, address_pattern)
      VALUES ('scope-rehydrate', 'key-rehydrate', 'MAIL_READ', NULL, '*')`).run();
    const stored = await ctx.storage.get<ConnectionState>(`conn:${connId}`);
    expect(stored).not.toBeUndefined();
    if (stored === undefined)
      throw new Error("Connection state was not stored");
    stored.acked = true;
    stored.principal = {
      tokenHash,
      kind: "API_KEY",
      id: "key-rehydrate",
    };
    stored.subscriptions = [
      {
        id: "persisted-subscription",
        query:
          "subscription ($scope: MailEventScope, $after: String) { mailEvents(scope: $scope, after: $after) { cursor type } }",
        operationName: null,
        variables: null,
        scope: { domainId: null, address: null },
        lastSeq: 57,
        live: true,
      },
    ];
    await ctx.storage.put(`conn:${connId}`, stored);
    const occurredAt = now;
    for (let seq = 1; seq <= 57; seq += 1) {
      await env.DB.prepare(`INSERT INTO mail_events
        (type, message_id, domain_id, addresses, occurred_at)
        VALUES ('MESSAGE_UPDATED', ?, 'domain-1', '["reader@example.com"]', ?)`)
        .bind(`message-${seq}`, occurredAt)
        .run();
    }
    const second = new MailEventHub(ctx, env, runtime(), {
      executor: TEST_EXECUTOR,
    });
    await second.webSocketMessage(pair.server, '{"type":"ping"}');
    expect(pair.server.sent).toContain('{"type":"pong"}');
    const resumed = await ctx.storage.get<ConnectionState>(`conn:${connId}`);
    expect(resumed?.subscriptions[0]?.lastSeq).toBe(57);
    expect(resumed?.subscriptions[0]?.id).toBe("persisted-subscription");
    await env.DB.prepare(`INSERT INTO mail_events
      (type, message_id, domain_id, addresses, occurred_at)
      VALUES ('MESSAGE_UPDATED', 'message-58', 'domain-1', '["reader@example.com"]', ?)`)
      .bind(occurredAt)
      .run();
    const response = await second.fetch(
      new Request("https://mail-event-hub.internal/notify", { method: "POST" }),
    );
    expect(response.status).toBe(204);
    const frames = pair.server.sent.map(
      (frame) => JSON.parse(frame) as Record<string, unknown>,
    );
    expect(frames).toContainEqual(
      expect.objectContaining({ id: "persisted-subscription", type: "next" }),
    );
    const deliveredFrame = frames.find(
      (frame) =>
        frame["id"] === "persisted-subscription" && frame["type"] === "next",
    );
    const payload = deliveredFrame?.["payload"] as {
      readonly data?: { readonly mailEvents?: { readonly cursor?: string } };
    };
    expect(payload.data?.mailEvents?.cursor).toMatch(/\.58$/);
    const delivered = await ctx.storage.get<ConnectionState>(`conn:${connId}`);
    expect(delivered?.subscriptions[0]?.lastSeq).toBe(58);
  });

  test("reconciliation deletes orphaned state and closes sockets without state", async () => {
    const ctx = new FakeState();
    const pair = { client: new FakeSocket(), server: new FakeSocket() };
    const first = new MailEventHub(ctx, env, runtime(pair));
    await connect(first);
    const connId = (pair.server.attachment as { readonly connId: string })
      .connId;
    await ctx.storage.delete(`conn:${connId}`);
    await ctx.storage.put("conn:orphan", {});

    const second = new MailEventHub(ctx, env, runtime());
    await second.webSocketMessage(pair.server, '{"type":"ping"}');

    expect(await ctx.storage.get("conn:orphan")).toBeUndefined();
    expect(pair.server.closed).toContainEqual({
      code: 1011,
      reason: "Internal error",
    });
  });

  test("returns 500 and closes the accepted socket when opening fails", async () => {
    const ctx = new FakeState();
    const pair = { client: new FakeSocket(), server: new FakeSocket() };
    vi.spyOn(pair.server, "serializeAttachment").mockImplementation(() => {
      throw new Error("attachment failure");
    });
    const hub = new MailEventHub(ctx, env, runtime(pair));

    const response = await connect(hub);

    expect(response.status).toBe(500);
    expect(pair.server.closed).toContainEqual({
      code: 1011,
      reason: "Internal error",
    });
  });

  test("alarm closes a connection after the 10 second initialization timeout", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const ctx = new FakeState();
    const pair = { client: new FakeSocket(), server: new FakeSocket() };
    const hub = new MailEventHub(ctx, env, runtime(pair));
    await connect(hub);
    now += 10_001;
    await hub.alarm();
    expect(pair.server.closed).toContainEqual({
      code: 4408,
      reason: "Connection initialization timed out",
    });
  });
});
