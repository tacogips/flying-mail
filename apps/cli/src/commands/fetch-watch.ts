import { CliError, ExitCode } from "../exit-codes";

const DEFAULT_INTERVAL_SECONDS = 30;
/** Floor for the poll interval: faster than this only hammers the API and
 * trips its rate limiter. */
export const MIN_POLL_INTERVAL_MS = 1000;
/** Ceiling for the backoff delay after consecutive transient failures. */
export const MAX_BACKOFF_MS = 60_000;
/** `setTimeout` treats delays above this (about 24.8 days) as 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** Converts `--interval <seconds>` into milliseconds.
 *
 * An absent flag means the default. A present but non-numeric, zero or
 * negative value is a usage error rather than a silent fallback: a zero
 * interval would turn `--watch` into a busy loop against the API. Valid
 * values are clamped to at least {@link MIN_POLL_INTERVAL_MS}. */
export function resolvePollIntervalMs(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_INTERVAL_SECONDS * 1000;
  }
  const seconds = raw.trim().length === 0 ? Number.NaN : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CliError(
      `Invalid --interval "${raw}": expected a positive number of seconds`,
      ExitCode.UsageError,
    );
  }
  return Math.min(
    MAX_TIMER_MS,
    Math.max(MIN_POLL_INTERVAL_MS, Math.round(seconds * 1000)),
  );
}

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
]);

/** Failures worth waiting out: the API asked us to slow down or is briefly
 * unavailable, or the network dropped. Auth, usage and not-found errors are
 * permanent and still end the loop. */
export function isTransientFailure(error: unknown): boolean {
  if (!(error instanceof CliError)) {
    return false;
  }
  return (
    error.exitCode === ExitCode.NetworkError ||
    (error.code !== undefined && TRANSIENT_CODES.has(error.code))
  );
}

/** Delay before the next poll after `failures` consecutive transient
 * failures: the interval doubles each time, capped at
 * {@link MAX_BACKOFF_MS}. A configured interval already above the cap is
 * never shortened. */
export function backoffDelayMs(intervalMs: number, failures: number): number {
  if (failures <= 0) {
    return intervalMs;
  }
  const scaled = intervalMs * 2 ** Math.min(failures, 16);
  return Math.max(intervalMs, Math.min(MAX_BACKOFF_MS, scaled));
}

export interface PollLoopDependencies {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly warn?: (message: string) => void;
  /** Checked before each sleep; lets tests (and signal handlers) end the
   * otherwise endless loop. */
  readonly shouldContinue?: () => boolean;
}

/** Polls immediately, then every `intervalMs`, until `shouldContinue`
 * says stop. Transient failures -- including on the very first poll --
 * double the wait up to {@link MAX_BACKOFF_MS}; the next success restores
 * the normal cadence. Non-transient errors propagate. */
export async function runPollLoop(
  poll: () => Promise<void>,
  intervalMs: number,
  deps: PollLoopDependencies = {},
): Promise<void> {
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const warn =
    deps.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const shouldContinue = deps.shouldContinue ?? (() => true);

  let failures = 0;
  for (;;) {
    try {
      await poll();
      failures = 0;
    } catch (error) {
      if (!isTransientFailure(error)) {
        throw error;
      }
      failures += 1;
      const detail = error instanceof Error ? error.message : "request failed";
      warn(
        `Poll failed (${detail}); retrying in ${Math.round(backoffDelayMs(intervalMs, failures) / 1000)}s.`,
      );
    }
    if (!shouldContinue()) {
      return;
    }
    await sleep(backoffDelayMs(intervalMs, failures));
  }
}
