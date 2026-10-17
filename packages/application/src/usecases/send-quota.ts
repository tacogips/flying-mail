import type { DomainId } from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { RateLimitedError } from "../errors";
import type { Viewer } from "../policies/viewer";
import { limitFailOpen } from "../ports/rate-limiter";

const SEND_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Stable, non-secret limiter key for the credential that is sending. */
function sendPrincipalKey(viewer: Viewer): string {
  return viewer.kind === "USER"
    ? `user:${viewer.userId}`
    : `key:${viewer.apiKeyId}`;
}

/** Cost guard shared by every outbound path (direct send, draft send and,
 * through the direct path, templated send). Runs after the capability check
 * and before anything is persisted, so a refused send leaves no row behind.
 *
 * Two independent limits apply:
 * 1. a per-credential burst limit from `deps.rateLimiter` (skipped when the
 *    deployment configures none), and
 * 2. a D1-backed rolling 24h budget of outbound messages per sending domain,
 *    `instanceConfig.maxSendsPerDomainPerDay`, which survives restarts and
 *    is shared by every credential sending as that domain.
 *
 * The budget check is count-then-insert, so concurrent sends can overshoot
 * it by the number of in-flight requests; it bounds cost, it is not a
 * transactional quota. */
export async function enforceSendQuota(
  deps: AppDependencies,
  viewer: Viewer,
  domainId: DomainId,
): Promise<void> {
  if (deps.rateLimiter !== null) {
    // Fails open: the burst limit is a cost guard, and a limiter outage
    // must not stop a legitimate send. The durable daily budget below still
    // applies either way.
    const allowed = await limitFailOpen(
      deps.rateLimiter,
      `send:${sendPrincipalKey(viewer)}`,
    );
    if (!allowed) {
      throw new RateLimitedError("Too many send requests; try again later");
    }
  }

  const since = new Date(
    deps.clock.now().getTime() - SEND_BUDGET_WINDOW_MS,
  ).toISOString();
  const sent = await deps.messageRepository.countOutboundSince(domainId, since);
  if (sent + 1 > deps.instanceConfig.maxSendsPerDomainPerDay) {
    throw new RateLimitedError(
      "The daily send limit for this domain has been reached; try again later",
    );
  }
}
