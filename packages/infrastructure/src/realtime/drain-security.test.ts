import { adminViewer } from "@flying-mail/application/test-support/viewer-fixtures";
import { MailEventType } from "@flying-mail/domain/entities/mail-event";
import {
  createDomainId,
  createMessageId,
} from "@flying-mail/domain/value-objects/ids";
import { describe, expect, test, vi } from "vitest";
import {
  createRealtimeTestBundle,
  messagesOfType,
  type RecordingSocket,
} from "./hub-test-support";

const DOMAIN_A = createDomainId("dom-a");
const EPOCH = "0123456789abcdef";
const QUERY =
  "subscription ($scope: MailEventScope, $after: String) { mailEvents(scope: $scope, after: $after) { cursor type domainId } }";

async function appendEvents(
  bundle: ReturnType<typeof createRealtimeTestBundle>,
  count: number,
): Promise<void> {
  await bundle.deps.mailEventLog.append(
    Array.from({ length: count }, (_, index) => ({
      type: MailEventType.MessageReceived,
      messageId: createMessageId(
        `security-${Date.now()}-${index}-${Math.random()}`,
      ),
      domainId: DOMAIN_A,
      addresses: ["inbox@example.test"],
    })),
    {
      occurredAt: "2026-08-23T00:00:00.000Z",
      retentionCutoff: "2026-08-16T00:00:00.000Z",
    },
  );
}

async function connect(
  bundle: ReturnType<typeof createRealtimeTestBundle>,
  token = "api-token",
) {
  const pair = bundle.attach();
  await bundle.hub.open(pair.connection, {
    clientIp: null,
    cookieTokenHash: null,
  });
  await bundle.hub.message(
    pair.connection,
    JSON.stringify({
      type: "connection_init",
      payload: { authorization: `Bearer ${token}` },
    }),
  );
  return pair;
}

async function subscribe(
  bundle: ReturnType<typeof createRealtimeTestBundle>,
  connection: { readonly id: string },
  id: string,
): Promise<void> {
  await bundle.hub.message(
    connection,
    JSON.stringify({
      type: "subscribe",
      id,
      payload: { query: QUERY, variables: { after: `${EPOCH}.0` } },
    }),
  );
  await bundle.hub.requestDrain();
}

function nextCursors(socket: RecordingSocket, id: string): string[] {
  return messagesOfType(socket, "next")
    .filter((message) => message["id"] === id)
    .map(
      (message) =>
        (message["payload"] as { data?: { mailEvents?: { cursor?: string } } })
          .data?.mailEvents?.cursor,
    )
    .filter((cursor): cursor is string => cursor !== undefined);
}

describe("realtime security regressions", () => {
  test("a revoked principal cannot stall a full replay page for another principal", async () => {
    const bundle = createRealtimeTestBundle();
    let revoked = false;
    vi.spyOn(bundle.usecases, "resolveViewerFromTokenHash").mockImplementation(
      async (tokenHash) =>
        revoked && tokenHash === "hash(revoked)" ? null : adminViewer(),
    );
    const pairs = [];
    for (const token of ["revoked", "valid"]) {
      const pair = bundle.attach();
      pairs.push(pair);
      await bundle.hub.open(pair.connection, {
        clientIp: null,
        cookieTokenHash: null,
      });
      await bundle.hub.message(
        pair.connection,
        JSON.stringify({
          type: "connection_init",
          payload: { authorization: `Bearer ${token}` },
        }),
      );
      await subscribe(bundle, pair.connection, token);
    }
    revoked = true;
    await appendEvents(bundle, 250);
    await bundle.hub.requestDrain();
    expect(pairs[0]?.socket.closes.at(-1)?.code).toBe(4401);
    const validPair = pairs[1];
    expect(validPair).toBeDefined();
    if (validPair === undefined)
      throw new Error("Valid connection was not created");
    expect(nextCursors(validPair.socket, "valid")).toEqual([
      `${EPOCH}.0`,
      ...Array.from({ length: 250 }, (_, index) => `${EPOCH}.${index + 1}`),
    ]);
  });

  test("drain keeps using hub state when host loadState returns copies", async () => {
    const bundle = createRealtimeTestBundle();
    const originalLoad = bundle.host.loadState.bind(bundle.host);
    vi.spyOn(bundle.host, "loadState").mockImplementation(
      async (connection) => {
        const state = await originalLoad(connection);
        return state === null ? null : structuredClone(state);
      },
    );
    const pair = await connect(bundle);
    await subscribe(bundle, pair.connection, "s");
    const before = nextCursors(pair.socket, "s");
    await bundle.hub.requestDrain();
    expect(nextCursors(pair.socket, "s")).toEqual(before);
    await appendEvents(bundle, 1);
    await bundle.hub.requestDrain();
    expect(nextCursors(pair.socket, "s")).toEqual([`${EPOCH}.0`, `${EPOCH}.1`]);
  });

  test("complete during execution prevents later sends for the forgotten subscription", async () => {
    const bundle = createRealtimeTestBundle();
    const pair = await connect(bundle);
    await subscribe(bundle, pair.connection, "s");
    const before = nextCursors(pair.socket, "s");
    await appendEvents(bundle, 1);
    const realExecute = bundle.executor.execute.bind(bundle.executor);
    let signalStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(bundle.executor, "execute").mockImplementation(
      async (prepared, payload, viewer) => {
        if (payload.type === MailEventType.MessageReceived) {
          signalStarted();
          await barrier;
        }
        return realExecute(prepared, payload, viewer);
      },
    );
    const draining = bundle.hub.requestDrain();
    await started;
    await bundle.hub.message(
      pair.connection,
      JSON.stringify({ type: "complete", id: "s" }),
    );
    release();
    await draining;
    expect(nextCursors(pair.socket, "s")).toEqual(before);
    expect(
      (await bundle.host.loadState(pair.connection))?.subscriptions,
    ).toHaveLength(0);
  });

  test("revoked principals without subscriptions are closed and removed", async () => {
    const bundle = createRealtimeTestBundle();
    const pair = await connect(bundle);
    bundle.setViewer(null);
    await bundle.hub.requestDrain();
    expect(pair.socket.closes.at(-1)?.code).toBe(4401);
    expect(await bundle.host.loadState(pair.connection)).toBeNull();
    expect(bundle.hub.admit(null)).toBe("OK");
  });

  test("deleted state is not saved again after an in-flight execution", async () => {
    const bundle = createRealtimeTestBundle();
    const pair = await connect(bundle);
    await subscribe(bundle, pair.connection, "s");
    await appendEvents(bundle, 1);
    const realExecute = bundle.executor.execute.bind(bundle.executor);
    let signalStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(bundle.executor, "execute").mockImplementation(
      async (prepared, payload, viewer) => {
        if (payload.type === MailEventType.MessageReceived) {
          signalStarted();
          await barrier;
        }
        return realExecute(prepared, payload, viewer);
      },
    );
    const save = vi.spyOn(bundle.host, "saveState");
    const draining = bundle.hub.requestDrain();
    await started;
    await bundle.hub.closed(pair.connection);
    const callsAfterDelete = save.mock.calls.length;
    release();
    await draining;
    expect(save).toHaveBeenCalledTimes(callsAfterDelete);
    expect(await bundle.host.loadState(pair.connection)).toBeNull();
  });
});
