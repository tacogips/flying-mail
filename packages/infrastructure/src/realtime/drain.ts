import {
  authorizesAnyAddress,
  hasAnyMailRead,
} from "@flying-mail/application/policies/authorization";
import type { AppDependencies } from "@flying-mail/application/dependencies";
import type { UseCases } from "@flying-mail/application/usecases";
import type { MailEventLogState } from "@flying-mail/application/ports/mail-event-log";
import { Capability } from "@flying-mail/domain/entities/api-key";
import { formatMailEventCursor } from "@flying-mail/domain/value-objects/mail-event-cursor";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import { createDomainId } from "@flying-mail/domain/value-objects/ids";
import type { SubscriptionExecutor, PreparedSubscription } from "./executor";
import type { ConnectionState, HubConnection, RealtimeHost } from "./host";
import type { MailEventPayload } from "./mail-event-payload";
import { graphqlError, matchesScope } from "./drain-helpers";
import { CloseCode, PRINCIPAL_CACHE_TTL_MS, REPLAY_PAGE } from "./protocol";

interface DrainOptions {
  readonly host: RealtimeHost;
  readonly deps: AppDependencies;
  readonly usecases: UseCases;
  readonly executor: SubscriptionExecutor;
  readonly listStates: () => readonly ActiveState[];
  readonly dropConnection: (
    connection: HubConnection,
    state: ConnectionState,
    code: number,
  ) => Promise<void>;
}

interface DrainController {
  requestDrain(): Promise<void>;
  forget(connId: string, subscriptionId?: string): void;
}

interface ActiveState {
  readonly connection: HubConnection;
  readonly state: ConnectionState;
}

interface PrincipalResult {
  readonly viewer: Awaited<ReturnType<UseCases["resolveViewerFromTokenHash"]>>;
  readonly closeCode: number | null;
}

interface CachedPrincipal {
  readonly result: PrincipalResult;
  readonly expiresAt: number;
}

interface SubscriptionEntry extends ActiveState {
  readonly subscription: ConnectionState["subscriptions"][number];
}

function safeSend(
  host: RealtimeHost,
  conn: HubConnection,
  value: unknown,
): void {
  try {
    host.send(conn, JSON.stringify(value));
  } catch {
    // A concurrently closed socket is removed by its close callback.
  }
}

function readableAddresses(
  viewer: NonNullable<PrincipalResult["viewer"]>,
  domainValue: string,
  addressValues: readonly string[],
): readonly ReturnType<typeof createEmailAddress>[] {
  let domainId: ReturnType<typeof createDomainId>;
  try {
    domainId = createDomainId(domainValue);
  } catch {
    return [];
  }
  const addresses = addressValues.flatMap((value) => {
    try {
      return [createEmailAddress(value)];
    } catch {
      return [];
    }
  });
  if (!authorizesAnyAddress(viewer, Capability.MailRead, domainId, addresses)) {
    return [];
  }
  return addresses.filter((address) =>
    authorizesAnyAddress(viewer, Capability.MailRead, domainId, [address]),
  );
}

export function createDrain(options: DrainOptions): DrainController {
  const preparedBySubscription = new Map<string, PreparedSubscription>();
  // Principal resolutions are reused for PRINCIPAL_CACHE_TTL_MS so repeated
  // passes (alarm plus notifications) do not hit storage for every principal.
  // Revocation is therefore noticed within one TTL.
  const principalCache = new Map<string, CachedPrincipal>();
  let running: Promise<void> | null = null;
  let dirty = false;

  function forget(connId: string, subscriptionId?: string): void {
    const prefix = `${connId}\u0000`;
    for (const key of preparedBySubscription.keys()) {
      if (
        key.startsWith(prefix) &&
        (subscriptionId === undefined || key === `${prefix}${subscriptionId}`)
      ) {
        preparedBySubscription.delete(key);
      }
    }
  }

  function isCurrent(state: ConnectionState): boolean {
    return options.listStates().some((entry) => entry.state === state);
  }

  function hasSubscription(
    state: ConnectionState,
    subscription: ConnectionState["subscriptions"][number],
  ): boolean {
    return isCurrent(state) && state.subscriptions.includes(subscription);
  }

  async function rebuildPrepared(
    connection: HubConnection,
    state: ConnectionState,
    subscription: ConnectionState["subscriptions"][number],
    viewer: NonNullable<PrincipalResult["viewer"]>,
  ): Promise<PreparedSubscription | null> {
    const key = `${state.connId}\u0000${subscription.id}`;
    if (!hasSubscription(state, subscription)) return null;
    const cached = preparedBySubscription.get(key);
    if (cached !== undefined) return cached;
    try {
      const result = options.executor.prepare(
        {
          query: subscription.query,
          operationName: subscription.operationName,
          variables: subscription.variables,
        },
        viewer,
      );
      if (!result.ok) {
        safeSend(options.host, connection, {
          id: subscription.id,
          type: "error",
          payload: result.errors,
        });
        return null;
      }
      preparedBySubscription.set(key, result.prepared);
      return result.prepared;
    } catch {
      safeSend(options.host, connection, {
        id: subscription.id,
        type: "error",
        payload: graphqlError("BAD_USER_INPUT", "Invalid subscription"),
      });
      return null;
    }
  }

  async function loadActiveStates(): Promise<ActiveState[]> {
    return options
      .listStates()
      .filter(({ state }) => state.acked && state.principal !== null);
  }

  async function resolvePrincipals(
    active: readonly ActiveState[],
  ): Promise<Map<string, PrincipalResult>> {
    const results = new Map<string, PrincipalResult>();
    const now = options.host.now();
    const activeHashes = new Set<string>();
    for (const { state } of active) {
      if (state.principal !== null) activeHashes.add(state.principal.tokenHash);
    }
    for (const tokenHash of principalCache.keys()) {
      if (!activeHashes.has(tokenHash)) principalCache.delete(tokenHash);
    }
    for (const tokenHash of activeHashes) {
      const cached = principalCache.get(tokenHash);
      if (cached !== undefined && now < cached.expiresAt) {
        results.set(tokenHash, cached.result);
        continue;
      }
      try {
        const viewer = await options.usecases.resolveViewerFromTokenHash(
          tokenHash,
          { recordUsage: false },
        );
        const result: PrincipalResult = {
          viewer,
          closeCode:
            viewer === null
              ? CloseCode.Unauthorized
              : hasAnyMailRead(viewer)
                ? null
                : CloseCode.Forbidden,
        };
        results.set(tokenHash, result);
        principalCache.set(tokenHash, {
          result,
          expiresAt: now + PRINCIPAL_CACHE_TTL_MS,
        });
      } catch {
        // Failures are not cached; the connection is dropped by this pass.
        results.set(tokenHash, {
          viewer: null,
          closeCode: CloseCode.Unauthorized,
        });
      }
    }
    return results;
  }

  /**
   * Delivers log rows to one bucket of subscriptions, reading from the lowest
   * cursor in that bucket. Returns the number of rows read; a full page means
   * the bucket has not reached the head of the log yet.
   */
  async function serveBucket(
    subscriptions: readonly SubscriptionEntry[],
    principalResults: ReadonlyMap<string, PrincipalResult>,
    logState: MailEventLogState,
    dirtyStates: Map<string, ActiveState>,
  ): Promise<number> {
    const from = Math.min(
      ...subscriptions.map(({ subscription }) => subscription.lastSeq),
    );
    const rows = await options.deps.mailEventLog.listAfter(from, REPLAY_PAGE);

    for (const { connection, state, subscription } of subscriptions) {
      if (!hasSubscription(state, subscription)) continue;
      const principal = state.principal;
      if (principal === null) continue;
      const viewer = principalResults.get(principal.tokenHash)?.viewer;
      if (viewer === null || viewer === undefined) continue;
      for (const row of rows) {
        if (!hasSubscription(state, subscription)) break;
        if (row.seq <= subscription.lastSeq) continue;
        if (matchesScope(subscription.scope, row)) {
          const addresses = readableAddresses(
            viewer,
            row.domainId,
            row.addresses,
          );
          if (addresses.length > 0) {
            const prepared = await rebuildPrepared(
              connection,
              state,
              subscription,
              viewer,
            );
            if (prepared !== null) {
              const payload: MailEventPayload = {
                cursor: formatMailEventCursor(logState.epoch, row.seq),
                type: row.type,
                messageId: row.messageId,
                domainId: row.domainId,
                addresses,
                occurredAt: row.occurredAt,
              };
              if (!hasSubscription(state, subscription)) break;
              try {
                const result = await options.executor.execute(
                  prepared,
                  payload,
                  viewer,
                );
                if (hasSubscription(state, subscription))
                  safeSend(options.host, connection, {
                    id: subscription.id,
                    type: "next",
                    payload: result,
                  });
              } catch {
                if (hasSubscription(state, subscription))
                  safeSend(options.host, connection, {
                    id: subscription.id,
                    type: "next",
                    payload: {
                      data: null,
                      errors: [{ message: "Internal error" }],
                    },
                  });
              }
            } else {
              state.subscriptions = state.subscriptions.filter(
                (item) => item.id !== subscription.id,
              );
              forget(state.connId, subscription.id);
            }
          }
        }
        subscription.lastSeq = row.seq;
        dirtyStates.set(state.connId, { connection, state });
      }
    }

    if (rows.length < REPLAY_PAGE) {
      for (const { connection, state, subscription } of subscriptions) {
        if (!hasSubscription(state, subscription) || subscription.live)
          continue;
        const principal = state.principal;
        if (principal === null) continue;
        const viewer = principalResults.get(principal.tokenHash)?.viewer;
        if (viewer === null || viewer === undefined) continue;
        const prepared = await rebuildPrepared(
          connection,
          state,
          subscription,
          viewer,
        );
        if (prepared === null) {
          state.subscriptions = state.subscriptions.filter(
            (item) => item.id !== subscription.id,
          );
          forget(state.connId, subscription.id);
          dirtyStates.set(state.connId, { connection, state });
          continue;
        }
        const payload: MailEventPayload = {
          cursor: formatMailEventCursor(logState.epoch, subscription.lastSeq),
          type: "LIVE",
          messageId: null,
          domainId: null,
          addresses: [],
          occurredAt: new Date(options.host.now()).toISOString(),
        };
        if (!hasSubscription(state, subscription)) continue;
        try {
          const result = await options.executor.execute(
            prepared,
            payload,
            viewer,
          );
          if (hasSubscription(state, subscription))
            safeSend(options.host, connection, {
              id: subscription.id,
              type: "next",
              payload: result,
            });
        } catch {
          if (hasSubscription(state, subscription))
            safeSend(options.host, connection, {
              id: subscription.id,
              type: "next",
              payload: { data: null, errors: [{ message: "Internal error" }] },
            });
        }
        if (!hasSubscription(state, subscription)) continue;
        subscription.live = true;
        dirtyStates.set(state.connId, { connection, state });
      }
    }
    return rows.length;
  }

  async function pass(): Promise<{
    readonly more: boolean;
    readonly hadSubscriptions: boolean;
  }> {
    const active = await loadActiveStates();
    const principalResults = await resolvePrincipals(active);
    const valid: ActiveState[] = [];
    for (const entry of active) {
      const principal = entry.state.principal;
      if (principal === null) continue;
      const result = principalResults.get(principal.tokenHash);
      if (result?.closeCode !== null && result?.closeCode !== undefined) {
        await options.dropConnection(
          entry.connection,
          entry.state,
          result.closeCode,
        );
      } else if (result?.viewer !== null && result?.viewer !== undefined) {
        valid.push(entry);
      }
    }
    const subscriptions = valid.flatMap(({ connection, state }) =>
      state.subscriptions.map((subscription) => ({
        connection,
        state,
        subscription,
      })),
    );
    if (subscriptions.length === 0)
      return { more: false, hadSubscriptions: false };

    // A subscription replaying old history must not delay subscriptions that
    // are at (or near) the head. Each bucket reads from its own lowest cursor,
    // so a lagging bucket costs at most one extra page per pass.
    const logState = await options.deps.mailEventLog.state();
    const replayFloor = logState.headSeq - REPLAY_PAGE;
    const nearHead = subscriptions.filter(
      ({ subscription }) => subscription.lastSeq >= replayFloor,
    );
    const lagging = subscriptions.filter(
      ({ subscription }) => subscription.lastSeq < replayFloor,
    );
    const dirtyStates = new Map<string, ActiveState>();
    let more = false;
    for (const bucket of [nearHead, lagging]) {
      if (bucket.length === 0) continue;
      const rowCount = await serveBucket(
        bucket,
        principalResults,
        logState,
        dirtyStates,
      );
      if (rowCount >= REPLAY_PAGE) more = true;
    }

    for (const { connection, state } of dirtyStates.values()) {
      if (isCurrent(state)) await options.host.saveState(connection, state);
    }
    return { more, hadSubscriptions: true };
  }

  async function drainLoop(): Promise<void> {
    do {
      dirty = false;
      const result = await pass();
      if (result.more) dirty = true;
      if (!result.hadSubscriptions) return;
    } while (dirty);
  }

  function requestDrain(): Promise<void> {
    if (running !== null) {
      dirty = true;
      return running;
    }
    running = drainLoop().finally(() => {
      running = null;
      if (dirty)
        void requestDrain().catch(() => {
          console.error("Realtime drain request failed");
        });
    });
    return running;
  }

  return { requestDrain, forget };
}
