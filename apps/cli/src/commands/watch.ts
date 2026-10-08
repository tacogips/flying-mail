import {
  createMailEventStream,
  type MailEventStream,
  type MailEventStreamOptions,
} from "@flying-mail/realtime-client";
import { flagBoolean, flagString, type ParsedArgs } from "../args";
import { createCliClient, requireEndpoint } from "../client";
import type { CliConfig } from "../config";
import { resolveConfig } from "../config";
import { CliError, ExitCode } from "../exit-codes";
import {
  cursorKey,
  readCursor,
  watchCursorsPath,
  writeCursor,
} from "../watch-cursors";

const MAIL_EVENTS_QUERY = `subscription WatchMailEvents($scope: MailEventScope, $after: String) {
  mailEvents(scope: $scope, after: $after) {
    cursor type messageId domainId addresses occurredAt
    message { subject from { address } }
  }
}`;
const DOMAINS_QUERY = `{ domains { id name } }`;

interface DomainRow {
  readonly id: string;
  readonly name: string;
}

interface SignalPort {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface WatchDependencies {
  readonly streamFactory?: (options: MailEventStreamOptions) => MailEventStream;
  readonly now?: () => number;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly signals?: SignalPort;
}

function defaultSignals(): SignalPort {
  return {
    once: (signal, listener) => process.once(signal, listener),
    removeListener: (signal, listener) =>
      process.removeListener(signal, listener),
  };
}

function websocketUrl(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CliError("Invalid endpoint URL.", ExitCode.UsageError);
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else {
    throw new CliError("Endpoint must use http or https.", ExitCode.UsageError);
  }
  url.pathname = "/graphql";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function resolveDomainId(
  domain: string | undefined,
  config: CliConfig,
): Promise<string | null> {
  if (domain === undefined) return null;
  const result = await createCliClient(config).request<{
    readonly domains: readonly DomainRow[];
  }>(DOMAINS_QUERY);
  const byId = result.domains.find((candidate) => candidate.id === domain);
  if (byId !== undefined) return byId.id;
  const byName = result.domains.find((candidate) => candidate.name === domain);
  if (byName !== undefined) return byName.id;
  throw new CliError(`Domain not found: ${domain}`, ExitCode.NotFoundError);
}

function eventValue(event: Record<string, unknown>, key: string): string {
  const value = event[key];
  return typeof value === "string" ? value : "-";
}

function eventAddresses(event: Record<string, unknown>): string {
  const addresses = event["addresses"];
  return Array.isArray(addresses)
    ? addresses
        .filter((item): item is string => typeof item === "string")
        .join(",")
    : "";
}

function eventSubject(event: Record<string, unknown>): string {
  const message = event["message"];
  if (typeof message !== "object" || message === null) return "-";
  const subject = (message as Record<string, unknown>)["subject"];
  return typeof subject === "string" && subject.length > 0 ? subject : "-";
}

export async function runWatch(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
  deps: WatchDependencies = {},
): Promise<ExitCode> {
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = deps.now ?? Date.now;
  const signals = deps.signals ?? defaultSignals();
  const config = await resolveConfig(args, env);
  const endpoint = requireEndpoint(config);
  const apiKey = config.apiKey;
  if (apiKey === null || apiKey.length === 0) {
    throw new CliError(
      "No API key configured. Pass --api-key, set FLYING_MAIL_API_KEY, or run `flying-mail config set apiKey <key>`.",
      ExitCode.UsageError,
    );
  }

  const domainId = await resolveDomainId(flagString(args, "domain"), config);
  const rawAddress = flagString(args, "address");
  const address = rawAddress === undefined ? null : rawAddress.toLowerCase();
  const scope = {
    ...(domainId === null ? {} : { domainId }),
    ...(address === null ? {} : { address }),
  };
  const path = watchCursorsPath(env);
  const key = cursorKey({ endpoint, apiKey, domainId, address });
  const initialCursor = await readCursor(path, key);
  const json = flagBoolean(args, "json");
  const streamFactory = deps.streamFactory ?? createMailEventStream;
  let stream: MailEventStream | null = null;
  let latestCursor = initialCursor;
  let dirty = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let lastFlushAt = now();
  let flushing: Promise<void> | null = null;
  let settled = false;

  const clearFlushTimer = (): void => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
  };
  const scheduleFlush = (): void => {
    if (settled || flushTimer !== undefined || flushing !== null || !dirty) {
      return;
    }
    const delay = Math.max(0, 1000 - (now() - lastFlushAt));
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushOne();
    }, delay);
  };
  const flushOne = async (): Promise<void> => {
    if (flushing !== null) return flushing;
    if (!dirty) return;
    dirty = false;
    const cursorToWrite = latestCursor;
    flushing = writeCursor(path, key, cursorToWrite)
      .then(() => {
        lastFlushAt = now();
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : "write failed";
        stderr(
          `Could not persist watch cursor: ${detail.replaceAll(apiKey, "[redacted]")}`,
        );
      })
      .finally(() => {
        flushing = null;
        if (dirty && !settled) scheduleFlush();
      });
    return flushing;
  };
  const flushOnExit = async (): Promise<void> => {
    clearFlushTimer();
    if (flushing !== null) await flushing;
    if (dirty) await flushOne();
  };

  return await new Promise<ExitCode>((resolve) => {
    let result: ExitCode = ExitCode.Success;
    const finish = (code: ExitCode): void => {
      if (settled) return;
      settled = true;
      result = code;
      clearFlushTimer();
      stream?.stop();
      void flushOnExit().finally(() => {
        signals.removeListener("SIGINT", onSignal);
        signals.removeListener("SIGTERM", onSignal);
        resolve(result);
      });
    };
    const onSignal = (): void => finish(ExitCode.Success);
    signals.once("SIGINT", onSignal);
    signals.once("SIGTERM", onSignal);

    const onCursor = (cursor: string | null): void => {
      latestCursor = cursor;
      dirty = true;
      scheduleFlush();
    };
    const options: MailEventStreamOptions = {
      url: websocketUrl(endpoint),
      query: MAIL_EVENTS_QUERY,
      scope,
      initialCursor,
      connectionParams: () => ({ authorization: `Bearer ${apiKey}` }),
      onCursor,
      onEvent: (event) => {
        if (json) {
          stdout(JSON.stringify(event));
        } else if (event["type"] === "LIVE") {
          stderr(`Live at ${eventValue(event, "cursor")}`);
        } else {
          stdout(
            `${eventValue(event, "occurredAt")} ${eventValue(event, "type")} ${eventValue(event, "messageId")} ${eventSubject(event)} ${eventAddresses(event)}`,
          );
        }
      },
      onResync: () => {
        if (json) stdout('{"type":"RESYNC_REQUIRED"}');
        else stderr("Cursor expired; resynchronizing from current mail state.");
      },
      onStatus: (status) => {
        if (!json && status !== "live") stderr(`Watch ${status}.`);
      },
      onAuthFailure: () => finish(ExitCode.AuthError),
      onFatal: ({ code }) =>
        finish(code === 4403 ? ExitCode.ForbiddenError : ExitCode.GeneralError),
    };

    try {
      stream = streamFactory(options);
      if (settled) stream.stop();
      else stream.start();
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Unable to start watch";
      stderr(detail.replaceAll(apiKey, "[redacted]"));
      finish(ExitCode.GeneralError);
    }
  });
}
