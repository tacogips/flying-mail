import type { EmailAddress } from "@mailcal/domain/value-objects/email-address";
import { emailDomainName } from "@mailcal/domain/value-objects/email-address";

/** Deliberately a small, explainable rule set rather than a trained
 * classifier: this is a self-hosted mail server, the score is shown to the
 * reader, and an operator has to be able to answer "why was this flagged?"
 * without a model. Weights come from
 * `design-docs/specs/design-mail-pipeline.md#spam-signals`. */
export const SPAM_WEIGHTS = {
  authFailure: 0.4,
  dmarcFailure: 0.3,
  fromMismatch: 0.15,
  phrase: 0.15,
} as const;

/** Cap on the total contribution of phrase matches, so a long body cannot
 * be pushed over the threshold by keywords alone. */
export const MAX_PHRASE_CONTRIBUTION = 0.45;

export interface SpamSignalInput {
  /** The `Authentication-Results` header, if the upstream MTA set one. */
  readonly authenticationResults: string | null;
  readonly envelopeFrom: EmailAddress;
  readonly headerFrom: EmailAddress;
  readonly subject: string;
  readonly bodyText: string | null;
  readonly blockedAddresses?: ReadonlySet<string>;
  readonly blockedDomains?: ReadonlySet<string>;
  readonly phrases?: readonly string[];
}

export interface SpamScore {
  /** Clamped to `[0, 1]`. */
  readonly score: number;
  /** Human-readable, stored so a client can explain the classification. */
  readonly reasons: readonly string[];
}

export interface AuthenticationVerdict {
  readonly spfFailed: boolean;
  readonly dkimFailed: boolean;
  readonly dmarcFailed: boolean;
}

/** Plain substring scan rather than a full RFC 8601 parser: anything
 * unrecognized contributes nothing, which is the right default when the
 * header is written by an upstream we do not control and a false positive
 * costs a reader their mail. */
export function parseAuthenticationResults(
  header: string | null,
): AuthenticationVerdict {
  if (header === null) {
    return { spfFailed: false, dkimFailed: false, dmarcFailed: false };
  }
  const normalized = header.toLowerCase();
  return {
    spfFailed:
      normalized.includes("spf=fail") || normalized.includes("spf=softfail"),
    dkimFailed: normalized.includes("dkim=fail"),
    dmarcFailed: normalized.includes("dmarc=fail"),
  };
}

function countPhraseMatches(
  haystack: string,
  phrases: readonly string[],
): readonly string[] {
  const normalized = haystack.toLowerCase();
  return phrases.filter(
    (phrase) =>
      phrase.trim().length > 0 &&
      normalized.includes(phrase.trim().toLowerCase()),
  );
}

/** Combines every signal into a single clamped score plus the reasons that
 * produced it. A blocklist hit short-circuits to 1.0: an operator's explicit
 * block is not something other signals should be able to dilute. */
export function scoreSpam(input: SpamSignalInput): SpamScore {
  const blockedAddresses = input.blockedAddresses ?? new Set<string>();
  const blockedDomains = input.blockedDomains ?? new Set<string>();

  if (blockedAddresses.has(input.envelopeFrom)) {
    return { score: 1, reasons: ["Sender address is on the blocklist"] };
  }
  if (blockedDomains.has(emailDomainName(input.envelopeFrom))) {
    return { score: 1, reasons: ["Sender domain is on the blocklist"] };
  }

  const reasons: string[] = [];
  let score = 0;

  const verdict = parseAuthenticationResults(input.authenticationResults);
  if (verdict.spfFailed || verdict.dkimFailed) {
    score += SPAM_WEIGHTS.authFailure;
    reasons.push(
      verdict.spfFailed && verdict.dkimFailed
        ? "SPF and DKIM both failed"
        : verdict.spfFailed
          ? "SPF failed"
          : "DKIM failed",
    );
  }
  if (verdict.dmarcFailed) {
    score += SPAM_WEIGHTS.dmarcFailure;
    reasons.push("DMARC failed");
  }

  if (
    emailDomainName(input.envelopeFrom) !== emailDomainName(input.headerFrom)
  ) {
    score += SPAM_WEIGHTS.fromMismatch;
    reasons.push("Envelope sender domain differs from the From header");
  }

  const phrases = input.phrases ?? [];
  if (phrases.length > 0) {
    const haystack = `${input.subject}\n${input.bodyText ?? ""}`;
    const matched = countPhraseMatches(haystack, phrases);
    if (matched.length > 0) {
      const contribution = Math.min(
        matched.length * SPAM_WEIGHTS.phrase,
        MAX_PHRASE_CONTRIBUTION,
      );
      score += contribution;
      reasons.push(`Matched ${matched.length} blocked phrase(s)`);
    }
  }

  return { score: Math.min(Math.max(score, 0), 1), reasons };
}

export function isSpam(score: SpamScore, threshold: number): boolean {
  return score.score >= threshold;
}
