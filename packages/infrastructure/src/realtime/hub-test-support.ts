import { createFakeDependencies } from "@flying-mail/application/test-support/fakes";
import { adminViewer } from "@flying-mail/application/test-support/viewer-fixtures";
import type { AppDependencies } from "@flying-mail/application/dependencies";
import type { UseCases } from "@flying-mail/application/usecases";
import type { Viewer } from "@flying-mail/application/policies";
import { createUseCases } from "@flying-mail/application/usecases";
import { buildSchema } from "graphql";
import { createSubscriptionExecutor } from "./executor";
import type { HubConnection } from "./host";
import {
  createInProcessHost,
  type InProcessHostOptions,
} from "./in-process-host";
import { createRealtimeHub } from "./hub";

export interface RecordedClose {
  readonly code: number;
  readonly reason: string;
}

export class RecordingSocket {
  readonly sent: string[] = [];
  readonly closes: RecordedClose[] = [];

  send(text: string): void {
    this.sent.push(text);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  messages(): readonly Record<string, unknown>[] {
    return this.sent.flatMap((value) => {
      try {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === "object" && parsed !== null
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
  }
}

export function createRealtimeTestDependencies(
  options: Parameters<typeof createFakeDependencies>[0] = {},
): ReturnType<typeof createFakeDependencies> {
  return createFakeDependencies(options);
}

export function messagesOfType(
  socket: RecordingSocket,
  type: string,
): readonly Record<string, unknown>[] {
  return socket.messages().filter((message) => message["type"] === type);
}

export async function connectionState(
  host: { loadState(conn: HubConnection): Promise<unknown> },
  conn: HubConnection,
): Promise<unknown> {
  return host.loadState(conn);
}

export function dependencies(
  fake: ReturnType<typeof createFakeDependencies>,
): AppDependencies {
  return fake.deps;
}

export function createRealtimeTestBundle(
  options: {
    readonly viewer?: Viewer | null;
    readonly now?: () => number;
    readonly hostOptions?: InProcessHostOptions;
    readonly rateLimiter?: NonNullable<
      Parameters<typeof createFakeDependencies>[0]
    >["rateLimiter"];
  } = {},
) {
  const fake = createFakeDependencies({
    ...(options.rateLimiter === undefined
      ? {}
      : { rateLimiter: options.rateLimiter }),
  });
  let currentViewer =
    options.viewer === undefined ? adminViewer() : options.viewer;
  const baseUseCases = createUseCases(fake.deps);
  const usecases: UseCases = {
    ...baseUseCases,
    resolveViewerFromToken: async () => currentViewer,
    resolveViewerFromTokenHash: async () => currentViewer,
  };
  const schema = buildSchema(`
    type Query { noop: String }
    enum MailEventType { MESSAGE_RECEIVED MESSAGE_SENT MESSAGE_UPDATED MESSAGE_DELETED DRAFT_SAVED DRAFT_DELETED LIVE }
    input MailEventScope { domainId: ID, address: String }
    type MailEvent { cursor: String!, type: MailEventType!, messageId: ID, domainId: ID, addresses: [String!]!, occurredAt: String! }
    type Subscription { mailEvents(scope: MailEventScope, after: String): MailEvent! }
  `);
  const executor = createSubscriptionExecutor({
    schema,
    deps: fake.deps,
    usecases,
    publicOrigin: null,
  });
  const host = createInProcessHost({
    ...(options.now === undefined ? {} : { now: options.now }),
    ...options.hostOptions,
  });
  const hub = createRealtimeHub({ host, deps: fake.deps, usecases, executor });
  return {
    fake,
    deps: fake.deps,
    host,
    hub,
    executor,
    usecases,
    setViewer(viewer: Viewer | null) {
      currentViewer = viewer;
    },
    attach() {
      const socket = new RecordingSocket();
      const connection = host.attach(socket);
      return { socket, connection };
    },
  };
}
