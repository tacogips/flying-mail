import {
  authorizesAnyAddress,
  hasAnyMailRead,
} from "@flying-mail/application/policies/authorization";
import type { AppDependencies } from "@flying-mail/application/dependencies";
import type { UseCases } from "@flying-mail/application/usecases";
import { Capability } from "@flying-mail/domain/entities/api-key";
import { formatMailEventCursor } from "@flying-mail/domain/value-objects/mail-event-cursor";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import { createDomainId } from "@flying-mail/domain/value-objects/ids";
import type { SubscriptionExecutor, PreparedSubscription } from "./executor";
import type { ConnectionState, HubConnection, RealtimeHost } from "./host";
import type { MailEventPayload } from "./mail-event-payload";
import { graphqlError, matchesScope } from "./drain-helpers";
import { CloseCode, REPLAY_PAGE } from "./protocol";

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
    for (const { state } of active) {
      const principal = state.principal;
      if (principal === null || results.has(principal.tokenHash)) continue;
      try {
        const viewer = await options.usecases.resolveViewerFromTokenHash(
          principal.tokenHash,
          { recordUsage: false },
        );
        results.set(principal.tokenHash, {
          viewer,
          closeCode:
            viewer === null
              ? CloseCode.Unauthorized
              : hasAnyMailRead(viewer)
                ? null
                : CloseCode.Forbidden,
        });
      } catch {
        results.set(principal.tokenHash, {
          viewer: null,
          closeCode: CloseCode.Unauthorized,
        });
      }
    }
    return results;
  }

  async function pass(): Promise<{
    readonly rowCount: number;
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
      return { rowCount: 0, hadSubscriptions: false };

    const from = Math.min(
      ...subscriptions.map(({ subscription }) => subscription.lastSeq),
    );
    const rows = await options.deps.mailEventLog.listAfter(from, REPLAY_PAGE);
    const logState = await options.deps.mailEventLog.state();
    const dirtyStates = new Map<string, ActiveState>();

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

    for (const { connection, state } of dirtyStates.values()) {
      if (isCurrent(state)) await options.host.saveState(connection, state);
    }
    return { rowCount: rows.length, hadSubscriptions: true };
  }

  async function drainLoop(): Promise<void> {
    do {
      dirty = false;
      const result = await pass();
      if (result.rowCount === REPLAY_PAGE) dirty = true;
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
