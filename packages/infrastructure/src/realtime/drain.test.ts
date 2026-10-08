import {
  adminViewer,
  buildMailPermissions,
  memberViewer,
} from "@flying-mail/application/test-support/viewer-fixtures";
import { MailEventType } from "@flying-mail/domain/entities/mail-event";
import { formatMailEventCursor } from "@flying-mail/domain/value-objects/mail-event-cursor";
import {
  createDomainId,
  createMessageId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRealtimeHub } from "./hub";
import {
  createRealtimeTestBundle,
  messagesOfType,
  type RecordingSocket,
} from "./hub-test-support";

const DOMAIN_A = createDomainId("dom-a");
const DOMAIN_B = createDomainId("dom-b");
const NOW = "2026-08-23T00:00:00.000Z";
const QUERY =
  "subscription ($scope: MailEventScope, $after: String) { mailEvents(scope: $scope, after: $after) { cursor type domainId } }";
const EPOCH = "0123456789abcdef";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function appendEvents(
  bundle: ReturnType<typeof createRealtimeTestBundle>,
  count: number,
  options: {
    readonly domainId?: ReturnType<typeof createDomainId>;
    readonly address?: string;
    readonly occurredAt?: string;
    readonly type?: MailEventType;
  } = {},
): Promise<void> {
  const domainId = options.domainId ?? DOMAIN_A;
  await bundle.deps.mailEventLog.append(
    Array.from({ length: count }, (_, index) => ({
      type: options.type ?? MailEventType.MessageReceived,
      messageId: createMessageId(`msg-${Date.now()}-${index}-${Math.random()}`),
      domainId,
      addresses: [options.address ?? "inbox@example.test"],
    })),
    {
      occurredAt: options.occurredAt ?? NOW,
      retentionCutoff: "2026-08-16T00:00:00.000Z",
    },
  );
}

async function setSubscriptionTypes(
  bundle: ReturnType<typeof createRealtimeTestBundle>,
  connection: { readonly id: string },
  id: string,
  types: readonly MailEventType[] | null,
  lastSeq = 0,
): Promise<ReturnType<typeof createRealtimeHub>> {
  const state = await bundle.host.loadState(connection);
  if (state === null) throw new Error("Subscription state was not found");
  const subscription = state.subscriptions.find((item) => item.id === id);
  if (subscription === undefined)
    throw new Error(`Subscription ${id} was not found`);
  await bundle.host.saveState(connection, {
    ...state,
    subscriptions: state.subscriptions.map((item) =>
      item.id === id
        ? {
            ...item,
            scope: { ...item.scope, types },
            lastSeq,
            live: false,
          }
        : item,
    ),
  });
  return createRehydratedHub(bundle);
}

async function createRehydratedHub(
  bundle: ReturnType<typeof createRealtimeTestBundle>,
): Promise<ReturnType<typeof createRealtimeHub>> {
  const hub = createRealtimeHub({
    host: bundle.host,
    deps: bundle.deps,
    usecases: bundle.usecases,
    executor: bundle.executor,
  });
  await hub.rehydrate();
  return hub;
}

async function connect(bundle: ReturnType<typeof createRealtimeTestBundle>) {
  const pair = bundle.attach();
  await bundle.hub.open(pair.connection, {
    clientIp: null,
    cookieTokenHash: null,
  });
  await bundle.hub.message(
    pair.connection,
    JSON.stringify({
      type: "connection_init",
      payload: { authorization: "Bearer api-token" },
    }),
  );
  return pair;
}

async function subscribe(
  bundle: ReturnType<typeof createRealtimeTestBundle>,
  connection: { readonly id: string },
  id: string,
  variables: Record<string, unknown>,
): Promise<void> {
  await bundle.hub.message(
    connection,
    JSON.stringify({
      type: "subscribe",
      id,
      payload: { query: QUERY, variables },
    }),
  );
  await bundle.hub.requestDrain();
}

function nextCursors(socket: RecordingSocket, id: string): string[] {
  return messagesOfType(socket, "next")
    .filter((message) => message["id"] === id)
    .map(
      (message) =>
        (
          message["payload"] as {
            readonly data?: {
              readonly mailEvents?: { readonly cursor?: string };
            };
          }
        )["data"]?.["mailEvents"]?.["cursor"],
    )
    .filter((cursor): cursor is string => cursor !== undefined);
}

describe("mail event drain", () => {
  test("filters types per subscription, advances filtered cursors, and emits LIVE at the head", async () => {
    const bundle = createRealtimeTestBundle();
    const pair = await connect(bundle);
    await subscribe(bundle, pair.connection, "sent", {
      after: `${EPOCH}.0`,
    });
    const hub = await setSubscriptionTypes(bundle, pair.connection, "sent", [
      MailEventType.MessageSent,
    ]);
    pair.socket.sent.length = 0;

    for (const type of [
      MailEventType.MessageReceived,
      MailEventType.MessageSent,
      MailEventType.MessageReceived,
      MailEventType.MessageSent,
      MailEventType.MessageReceived,
      MailEventType.MessageSent,
      MailEventType.MessageReceived,
    ]) {
      await appendEvents(bundle, 1, { type });
    }
    await hub.requestDrain();

    expect(nextCursors(pair.socket, "sent")).toEqual([
      `${EPOCH}.2`,
      `${EPOCH}.4`,
      `${EPOCH}.6`,
      `${EPOCH}.7`,
    ]);
    expect(
      messagesOfType(pair.socket, "next").filter(
        (message) =>
          (message["payload"] as { data?: { mailEvents?: { type?: string } } })
            .data?.mailEvents?.type === "LIVE",
      ),
    ).toHaveLength(1);
    expect(
      (await bundle.host.loadState(pair.connection))?.subscriptions[0]?.lastSeq,
    ).toBe(7);
  });

  test("replays filtered types after a cursor without duplicates and keeps subscriptions independent", async () => {
    const bundle = createRealtimeTestBundle();
    for (const type of [
      MailEventType.MessageReceived,
      MailEventType.MessageSent,
      MailEventType.MessageReceived,
      MailEventType.MessageSent,
    ]) {
      await appendEvents(bundle, 1, { type });
    }
    const pair = await connect(bundle);
    await subscribe(bundle, pair.connection, "sent-after-four", {
      after: `${EPOCH}.4`,
    });
    await subscribe(bundle, pair.connection, "received-after-four", {
      after: `${EPOCH}.4`,
    });
    const state = await bundle.host.loadState(pair.connection);
    if (state === null) throw new Error("Connection state was not found");
    await bundle.host.saveState(pair.connection, {
      ...state,
      subscriptions: state.subscriptions.map((item) => ({
        ...item,
        scope: {
          ...item.scope,
          types:
            item.id === "sent-after-four"
              ? [MailEventType.MessageSent]
              : [MailEventType.MessageReceived],
        },
        lastSeq: 4,
        live: false,
      })),
    });
    const hub = await createRehydratedHub(bundle);
    pair.socket.sent.length = 0;
    await appendEvents(bundle, 1, { type: MailEventType.MessageReceived });
    await appendEvents(bundle, 1, { type: MailEventType.MessageSent });
    await appendEvents(bundle, 1, { type: MailEventType.MessageReceived });
    await hub.requestDrain();

    expect(nextCursors(pair.socket, "sent-after-four")).toEqual([
      `${EPOCH}.6`,
      `${EPOCH}.7`,
    ]);
    expect(nextCursors(pair.socket, "received-after-four")).toEqual([
      `${EPOCH}.5`,
      `${EPOCH}.7`,
      `${EPOCH}.7`,
    ]);
    expect(
      (await bundle.host.loadState(pair.connection))?.subscriptions[0]?.lastSeq,
    ).toBe(7);
  });

  test("combines type and domain filters with legacy scopes matching all types", async () => {
    const bundle = createRealtimeTestBundle();
    const pair = await connect(bundle);
    await subscribe(bundle, pair.connection, "legacy", { after: `${EPOCH}.0` });
    await subscribe(bundle, pair.connection, "scoped", { after: `${EPOCH}.0` });
    const state = await bundle.host.loadState(pair.connection);
    if (state === null) throw new Error("Connection state was not found");
    await bundle.host.saveState(pair.connection, {
      ...state,
      subscriptions: state.subscriptions.map((item) =>
        item.id === "scoped"
          ? {
              ...item,
              scope: {
                domainId: DOMAIN_A,
                address: null,
                types: [MailEventType.MessageSent],
              },
              live: false,
            }
          : { ...item, scope: { domainId: null, address: null }, live: false },
      ),
    });
    const hub = await createRehydratedHub(bundle);
    pair.socket.sent.length = 0;
    await appendEvents(bundle, 1, {
      domainId: DOMAIN_B,
      type: MailEventType.MessageSent,
    });
    await appendEvents(bundle, 1, {
      domainId: DOMAIN_A,
      type: MailEventType.MessageReceived,
    });
    await appendEvents(bundle, 1, {
      domainId: DOMAIN_A,
      type: MailEventType.MessageSent,
    });
    await hub.requestDrain();

    expect(nextCursors(pair.socket, "legacy")).toEqual([
      `${EPOCH}.1`,
      `${EPOCH}.2`,
      `${EPOCH}.3`,
      `${EPOCH}.3`,
    ]);
    expect(nextCursors(pair.socket, "scoped")).toEqual([
      `${EPOCH}.3`,
      `${EPOCH}.3`,
    ]);
    const finalState = await bundle.host.loadState(pair.connection);
    expect(finalState?.subscriptions.map(({ lastSeq }) => lastSeq)).toEqual([
      3, 3,
    ]);
  });

  test("replays after the supplied cursor in order, then emits LIVE at the head", async () => {
    const bundle = createRealtimeTestBundle();
    await appendEvents(bundle, 5);
    const pair = await connect(bundle);
    await subscribe(bundle, pair.connection, "s", {
      after: formatMailEventCursor(EPOCH, 2),
    });
    expect(nextCursors(pair.socket, "s")).toEqual([
      `${EPOCH}.3`,
      `${EPOCH}.4`,
      `${EPOCH}.5`,
      `${EPOCH}.5`,
    ]);
    expect(
      messagesOfType(pair.socket, "next").at(-1)?.["payload"],
    ).toMatchObject({ data: { mailEvents: { type: "LIVE" } } });
  });

  test("drains 450 rows across pages, folds reordered pokes, and includes rows appended during replay", async () => {
    const bundle = createRealtimeTestBundle();
    await appendEvents(bundle, 450);
    const pair = await connect(bundle);
    const originalListAfter = bundle.deps.mailEventLog.listAfter.bind(
      bundle.deps.mailEventLog,
    );
    let appendedDuringRead = false;
    vi.spyOn(bundle.deps.mailEventLog, "listAfter").mockImplementation(
      async (seq, limit) => {
        const rows = await originalListAfter(seq, limit);
        if (!appendedDuringRead && seq === 0) {
          appendedDuringRead = true;
          await appendEvents(bundle, 3);
        }
        return rows;
      },
    );
    const realExecute = bundle.executor.execute.bind(bundle.executor);
    let appendedDuringExecute = false;
    vi.spyOn(bundle.executor, "execute").mockImplementation(
      async (prepared, payload, viewer) => {
        if (
          payload.type === MailEventType.MessageReceived &&
          payload.cursor.endsWith(".1")
        ) {
          if (!appendedDuringExecute) {
            appendedDuringExecute = true;
            await appendEvents(bundle, 3);
          }
          for (let index = 0; index < 5; index += 1)
            void bundle.hub.requestDrain();
        }
        return realExecute(prepared, payload, viewer);
      },
    );
    await subscribe(bundle, pair.connection, "s", { after: `${EPOCH}.0` });
    const cursors = nextCursors(pair.socket, "s");
    expect(cursors).toHaveLength(457);
    expect(cursors[0]).toBe(`${EPOCH}.1`);
    expect(cursors.slice(0, -1)).toEqual(
      Array.from({ length: 456 }, (_, index) => `${EPOCH}.${index + 1}`),
    );
    expect(cursors.at(-2)).toBe(`${EPOCH}.456`);
    expect(cursors.at(-1)).toBe(`${EPOCH}.456`);
  });

  test("wake catches a missed notification and returns LIVE only once", async () => {
    const bundle = createRealtimeTestBundle();
    const pair = await connect(bundle);
    await subscribe(bundle, pair.connection, "s", {});
    await appendEvents(bundle, 1);
    await bundle.hub.wake();
    expect(nextCursors(pair.socket, "s")).toEqual([`${EPOCH}.0`, `${EPOCH}.1`]);
  });

  test("identical query text keeps domain variables independent", async () => {
    const bundle = createRealtimeTestBundle();
    await appendEvents(bundle, 1, { domainId: DOMAIN_A });
    await appendEvents(bundle, 1, { domainId: DOMAIN_B });
    const pair = await connect(bundle);
    await subscribe(bundle, pair.connection, "a", {
      scope: { domainId: DOMAIN_A },
      after: `${EPOCH}.0`,
    });
    await subscribe(bundle, pair.connection, "b", {
      scope: { domainId: DOMAIN_B },
      after: `${EPOCH}.0`,
    });
    const byId = (id: string) =>
      messagesOfType(pair.socket, "next")
        .filter((message) => message["id"] === id)
        .map(
          (message) =>
            (
              message["payload"] as {
                data: { mailEvents: { domainId: string | null } };
              }
            ).data.mailEvents.domainId,
        )
        .filter((value) => value !== null);
    expect(byId("a")).toEqual([DOMAIN_A]);
    expect(byId("b")).toEqual([DOMAIN_B]);
  });

  test("rechecks permission for each pass and closes a revoked principal", async () => {
    const bundle = createRealtimeTestBundle();
    const pair = await connect(bundle);
    await subscribe(bundle, pair.connection, "s", {});
    await appendEvents(bundle, 1, { address: "readable@example.test" });
    await bundle.hub.requestDrain();
    const permission = buildMailPermissions(createUserId("usr-admin"), [
      {
        effect: "DENY",
        domainId: DOMAIN_A,
        addressPattern: "readable@example.test",
      },
    ]);
    bundle.setViewer(adminViewer("usr-admin", permission));
    await appendEvents(bundle, 1, { address: "readable@example.test" });
    await bundle.hub.requestDrain();
    expect(nextCursors(pair.socket, "s")).toEqual([`${EPOCH}.0`, `${EPOCH}.1`]);
    bundle.setViewer(null);
    await appendEvents(bundle, 1);
    await bundle.hub.requestDrain();
    expect(pair.socket.closes.at(-1)?.code).toBe(4401);
  });

  test("skips unauthorized rows while advancing lastSeq and delivering later authorized rows", async () => {
    const permission = buildMailPermissions(createUserId("usr-member"), [
      {
        effect: "ALLOW",
        domainId: DOMAIN_A,
        addressPattern: "allowed@example.test",
      },
    ]);
    const bundle = createRealtimeTestBundle({
      viewer: memberViewer("usr-member", permission),
    });
    const pair = await connect(bundle);
    await subscribe(bundle, pair.connection, "s", { after: `${EPOCH}.0` });
    await appendEvents(bundle, 1, { address: "denied@example.test" });
    await appendEvents(bundle, 1, { address: "allowed@example.test" });
    await bundle.hub.requestDrain();

    const eventMessages = messagesOfType(pair.socket, "next").filter(
      (message) => {
        const payload = message["payload"] as {
          readonly data?: {
            readonly mailEvents?: { readonly type?: string };
          };
        };
        return payload.data?.mailEvents?.type === "MESSAGE_RECEIVED";
      },
    );
    expect(eventMessages).toHaveLength(1);
    expect(nextCursors(pair.socket, "s")).toEqual([`${EPOCH}.0`, `${EPOCH}.2`]);
    const state = await bundle.host.loadState(pair.connection);
    expect(state?.subscriptions[0]?.lastSeq).toBe(2);
  });

  test("rejects invalid cursors and accepts the pruned-through cursor", async () => {
    const bundle = createRealtimeTestBundle();
    await appendEvents(bundle, 1, { occurredAt: "2026-08-01T00:00:00.000Z" });
    await appendEvents(bundle, 1);
    const invalidCursors = [
      "bad",
      "fedcba9876543210.1",
      `${EPOCH}.3`,
      `${EPOCH}.0`,
    ];
    for (const [index, after] of invalidCursors.entries()) {
      const pair = await connect(bundle);
      await subscribe(bundle, pair.connection, `bad${index}`, { after });
      expect(
        messagesOfType(pair.socket, "error").at(-1)?.["payload"],
      ).toMatchObject([
        {
          extensions: {
            code: after === "bad" ? "BAD_USER_INPUT" : "RESYNC_REQUIRED",
          },
        },
      ]);
      await bundle.hub.closed(pair.connection);
    }
    const pair = await connect(bundle);
    await subscribe(bundle, pair.connection, "pruned", { after: `${EPOCH}.1` });
    expect(messagesOfType(pair.socket, "error")).toHaveLength(0);
    expect(nextCursors(pair.socket, "pruned")).toEqual([
      `${EPOCH}.2`,
      `${EPOCH}.2`,
    ]);
  });

  test("rehydrates stored subscriptions and resumes after persisted lastSeq", async () => {
    const bundle = createRealtimeTestBundle();
    await appendEvents(bundle, 1);
    const pair = await connect(bundle);
    await subscribe(bundle, pair.connection, "s", { after: `${EPOCH}.0` });
    expect(nextCursors(pair.socket, "s")).toEqual([`${EPOCH}.1`, `${EPOCH}.1`]);
    await appendEvents(bundle, 1);
    const restoredHub = createRealtimeHub({
      host: bundle.host,
      deps: bundle.deps,
      usecases: bundle.usecases,
      executor: bundle.executor,
    });
    await restoredHub.rehydrate();
    await restoredHub.requestDrain();
    expect(nextCursors(pair.socket, "s")).toEqual([
      `${EPOCH}.1`,
      `${EPOCH}.1`,
      `${EPOCH}.2`,
    ]);
  });
});
