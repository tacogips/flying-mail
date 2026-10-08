import { createLocalApp } from "./server";
import { createBunRealtimeHandlers } from "./realtime-bun";
import type {
  BunRealtimeServer,
  BunRealtimeSocket,
  BunRealtimeSocketData,
} from "./realtime-bun";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { verifyMailDomain } from "@flying-mail/domain/entities/mail-domain";
import { Capability } from "@flying-mail/domain/entities/api-key";
import type {
  PreparedSubscription,
  SubscriptionExecutor,
} from "@flying-mail/infrastructure/realtime/executor";

const BOOTSTRAP_TOKEN = "realtime-test-bootstrap-token-with-32-chars";
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
const ORIGINAL_ENV = { ...process.env };

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
      data: { mailEvents: { cursor: payload.cursor, type: payload.type } },
    } as Awaited<ReturnType<SubscriptionExecutor["execute"]>>;
  },
};

class FakeServer implements BunRealtimeServer {
  upgradeOptions: Parameters<BunRealtimeServer["upgrade"]>[1] | null = null;
  shouldUpgrade = true;

  requestIP(): { readonly address: string } | null {
    return { address: "192.0.2.42" };
  }

  upgrade(
    _request: Request,
    options: Parameters<BunRealtimeServer["upgrade"]>[1],
  ): boolean {
    this.upgradeOptions = options;
    return this.shouldUpgrade;
  }
}

class FakeSocket implements BunRealtimeSocket {
  readonly sent: string[] = [];
  readonly closed: { readonly code: number; readonly reason: string }[] = [];
  readonly data: BunRealtimeSocketData;

  constructor(data: BunRealtimeSocketData) {
    this.data = data;
  }

  send(text: string): void {
    this.sent.push(text);
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }
}

function upgradeRequest(origin?: string): Request {
  return new Request("http://localhost:8787/graphql", {
    method: "GET",
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": "graphql-transport-ws",
      ...(origin === undefined ? {} : { Origin: origin }),
    },
  });
}

describe("createBunRealtimeHandlers", () => {
  beforeEach(() => {
    process.env["FLYING_MAIL_SQLITE_URL"] = ":memory:";
    process.env["FLYING_MAIL_BLOB_BACKEND"] = "memory";
    process.env["FLYING_MAIL_BOOTSTRAP_TOKEN"] = BOOTSTRAP_TOKEN;
    delete process.env["FLYING_MAIL_PUBLIC_ORIGIN"];
    delete process.env["FLYING_MAIL_MAIL_FROM"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  test("upgrades valid requests and stores only the normalized peer address", async () => {
    const local = await createLocalApp(MIGRATIONS_DIR);
    const handlers = createBunRealtimeHandlers({
      hub: local.realtime.hub,
      host: local.realtime.host,
      deps: local.deps,
    });
    const server = new FakeServer();
    const request = upgradeRequest();

    await expect(handlers.upgrade(request, server)).resolves.toBeUndefined();
    expect(server.upgradeOptions).toMatchObject({
      headers: { "Sec-WebSocket-Protocol": "graphql-transport-ws" },
      data: {
        info: { clientIp: "192.0.2.42", cookieTokenHash: null },
      },
    });
    expect(server.upgradeOptions?.data.info.cookieTokenHash).toBeNull();
    expect(server.upgradeOptions?.data.info.clientIp).toBe("192.0.2.42");
  });

  test("rejects a cross-origin request before calling server.upgrade", async () => {
    process.env["FLYING_MAIL_PUBLIC_ORIGIN"] = "https://mail.example.test";
    const local = await createLocalApp(MIGRATIONS_DIR);
    const handlers = createBunRealtimeHandlers({
      hub: local.realtime.hub,
      host: local.realtime.host,
      deps: local.deps,
    });
    const server = new FakeServer();

    const response = await handlers.upgrade(
      upgradeRequest("https://attacker.example"),
      server,
    );
    expect(response?.status).toBe(403);
    expect(server.upgradeOptions).toBeNull();
  });

  test("authenticates and pokes the in-process hub after ingest", async () => {
    const local = await createLocalApp(MIGRATIONS_DIR, {
      realtimeExecutor: TEST_EXECUTOR,
    });
    const { user } = await local.usecases.bootstrapAdmin({
      email: "admin@example.com",
      name: "Realtime Admin",
      token: BOOTSTRAP_TOKEN,
      clientIp: null,
    });
    const adminViewer = {
      kind: "USER" as const,
      userId: user.id,
      role: user.role,
      permissions: [],
      templatePermissions: [],
    };
    const domain = await local.usecases.createDomain(
      adminViewer,
      "example.com",
      true,
    );
    await local.deps.mailDomainRepository.save(
      verifyMailDomain(domain, new Date().toISOString()),
    );
    const key = await local.usecases.createApiKey(adminViewer, {
      name: "realtime test",
      expiresAt: null,
      scopes: [
        {
          capability: Capability.MailRead,
          domainId: domain.id,
          addressPattern: "*",
        },
      ],
    });
    const handlers = createBunRealtimeHandlers({
      hub: local.realtime.hub,
      host: local.realtime.host,
      deps: local.deps,
    });
    const server = new FakeServer();
    await handlers.upgrade(upgradeRequest(), server);
    const info = server.upgradeOptions?.data.info;
    expect(info).toBeDefined();
    if (info === undefined) throw new Error("Upgrade info was not stored");
    const socket = new FakeSocket({ info });

    await handlers.websocket.open(socket);
    await handlers.websocket.message(
      socket,
      JSON.stringify({
        type: "connection_init",
        payload: { authorization: `Bearer ${key.secret}` },
      }),
    );
    await handlers.websocket.message(
      socket,
      JSON.stringify({
        type: "subscribe",
        id: "live-mail",
        payload: {
          query:
            "subscription ($scope: MailEventScope, $after: String) { mailEvents(scope: $scope, after: $after) { cursor type } }",
        },
      }),
    );
    await local.realtime.hub.requestDrain();

    const raw = new TextEncoder().encode(
      [
        "From: Sender <sender@other.com>",
        "To: support@example.com",
        "Subject: In process event",
        "Message-ID: <realtime-1@other.com>",
        "Content-Type: text/plain",
        "",
        "Realtime body",
        "",
      ].join("\r\n"),
    );
    const conn = socket.data.conn;
    await local.usecases.receiveMessage({
      envelopeFrom: "sender@other.com",
      envelopeTo: "support@example.com",
      raw,
      rawSize: raw.byteLength,
      headers: new Map(),
    });
    expect((await local.deps.mailEventLog.state()).headSeq).toBeGreaterThan(0);
    await local.realtime.hub.requestDrain();
    const frames = socket.sent.map(
      (value) => JSON.parse(value) as Record<string, unknown>,
    );
    expect(frames).toContainEqual({ type: "connection_ack" });
    const nextFrames = frames.filter((frame) => frame["type"] === "next");
    expect(
      nextFrames.some((frame) => {
        const payload = frame["payload"] as {
          readonly data?: { readonly mailEvents?: { readonly type?: string } };
        };
        return payload.data?.mailEvents?.type === "MESSAGE_RECEIVED";
      }),
    ).toBe(true);
    expect(
      nextFrames.some((frame) => {
        const payload = frame["payload"] as {
          readonly data?: { readonly mailEvents?: { readonly type?: string } };
        };
        return payload.data?.mailEvents?.type === "LIVE";
      }),
    ).toBe(true);
    await handlers.websocket.close(socket);
    expect(conn).toBeDefined();
    if (conn !== undefined)
      expect(await local.realtime.host.loadState(conn)).toBeNull();
  });

  test("returns 400 if Bun refuses the upgrade", async () => {
    const local = await createLocalApp(MIGRATIONS_DIR);
    const handlers = createBunRealtimeHandlers({
      hub: local.realtime.hub,
      host: local.realtime.host,
      deps: local.deps,
    });
    const server = new FakeServer();
    server.shouldUpgrade = false;

    const response = await handlers.upgrade(upgradeRequest(), server);
    expect(response?.status).toBe(400);
  });

  test("contains open and message callback failures and closes with 1011", async () => {
    const local = await createLocalApp(MIGRATIONS_DIR);
    const handlers = createBunRealtimeHandlers({
      hub: local.realtime.hub,
      host: local.realtime.host,
      deps: local.deps,
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const failedOpenSocket = new FakeSocket({
      info: { clientIp: "192.0.2.42", cookieTokenHash: null },
    });
    vi.spyOn(local.realtime.hub, "open").mockRejectedValueOnce(
      new Error("open failed"),
    );
    await expect(
      handlers.websocket.open(failedOpenSocket),
    ).resolves.toBeUndefined();
    expect(failedOpenSocket.closed).toContainEqual({
      code: 1011,
      reason: "Internal error",
    });

    const failedMessageSocket = new FakeSocket({
      info: { clientIp: "192.0.2.42", cookieTokenHash: null },
    });
    await handlers.websocket.open(failedMessageSocket);
    vi.spyOn(local.realtime.hub, "message").mockRejectedValueOnce(
      new Error("message failed"),
    );
    await expect(
      handlers.websocket.message(failedMessageSocket, '{"type":"ping"}'),
    ).resolves.toBeUndefined();
    expect(failedMessageSocket.closed).toContainEqual({
      code: 1011,
      reason: "Internal error",
    });
    expect(errorLog).toHaveBeenCalledTimes(2);
    await handlers.websocket.close(failedMessageSocket);
  });
});
