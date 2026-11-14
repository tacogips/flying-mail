import { ValidationError } from "../errors";
import type { EmailAddress } from "../value-objects/email-address";
import type {
  ClassificationRuleId,
  DomainId,
  TagId,
} from "../value-objects/ids";

/** Which message property a rule tests. `SENDER_DOMAIN` is the part of the
 * from address after the `@`, so one rule covers every sender at an
 * organization. */
export enum RuleField {
  SenderAddress = "SENDER_ADDRESS",
  SenderDomain = "SENDER_DOMAIN",
  Subject = "SUBJECT",
  ListId = "LIST_ID",
}

export enum RuleMatcher {
  /** Case-insensitive equality. */
  Exact = "EXACT",
  /** Case-insensitive substring. */
  Contains = "CONTAINS",
  /** JavaScript regular expression, applied case-insensitively. Rules are
   * operator-authored (DOMAIN_ADMIN), so the usual attacker-supplied-regex
   * concern does not apply; inputs are still truncated before matching so
   * a pathological pattern cannot stall ingest on a huge subject. */
  Regex = "REGEX",
}

export enum RuleAction {
  /** Record a spam verdict (a `message_spam` row, marked by RULE). */
  Spam = "SPAM",
  /** Set the mailing-list flag on the message. */
  MailingList = "MAILING_LIST",
  /** Apply `tagId` to the message. */
  Tag = "TAG",
}

/** Operator-defined ingest rule: when `field` matches `pattern`, perform
 * `action` on the incoming message. Evaluated for every inbound message on
 * the rule's domain (or every domain when `domainId` is null). */
export interface ClassificationRule {
  readonly id: ClassificationRuleId;
  /** Restricts the rule to one receiving domain; null applies everywhere. */
  readonly domainId: DomainId | null;
  readonly field: RuleField;
  readonly matcher: RuleMatcher;
  readonly pattern: string;
  readonly action: RuleAction;
  /** Required exactly when `action` is `TAG`. */
  readonly tagId: TagId | null;
  readonly enabled: boolean;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateClassificationRuleInput {
  readonly id: ClassificationRuleId;
  readonly domainId: DomainId | null;
  readonly field: RuleField;
  readonly matcher: RuleMatcher;
  readonly pattern: string;
  readonly action: RuleAction;
  readonly tagId: TagId | null;
  readonly description: string | null;
  readonly createdAt: string;
}

const MAX_PATTERN_LENGTH = 512;
/** Match inputs are truncated to this length so an expensive regex cannot
 * stall ingest on an arbitrarily long subject line. */
const MAX_INPUT_LENGTH = 1024;

function normalizePattern(matcher: RuleMatcher, pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("rule pattern must not be empty", "pattern");
  }
  if (trimmed.length > MAX_PATTERN_LENGTH) {
    throw new ValidationError(
      `rule pattern must be at most ${MAX_PATTERN_LENGTH} characters`,
      "pattern",
    );
  }
  if (matcher === RuleMatcher.Regex) {
    try {
      compileRulePattern(trimmed);
    } catch {
      throw new ValidationError(
        "rule pattern is not a valid regular expression",
        "pattern",
      );
    }
  }
  return trimmed;
}

export function createClassificationRule(
  input: CreateClassificationRuleInput,
): ClassificationRule {
  if ((input.action === RuleAction.Tag) !== (input.tagId !== null)) {
    throw new ValidationError(
      "tagId is required for a TAG rule and not allowed otherwise",
      "tagId",
    );
  }
  return {
    id: input.id,
    domainId: input.domainId,
    field: input.field,
    matcher: input.matcher,
    pattern: normalizePattern(input.matcher, input.pattern),
    action: input.action,
    tagId: input.tagId,
    enabled: true,
    description: input.description,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function setRuleEnabled(
  rule: ClassificationRule,
  enabled: boolean,
  at: string,
): ClassificationRule {
  return rule.enabled === enabled ? rule : { ...rule, enabled, updatedAt: at };
}

export function compileRulePattern(pattern: string): RegExp {
  return new RegExp(pattern, "i");
}

/** The message properties rules are matched against. */
export interface RuleMatchInput {
  readonly senderAddress: EmailAddress;
  readonly subject: string;
  readonly listId: string | null;
}

function fieldValue(
  rule: ClassificationRule,
  input: RuleMatchInput,
): string | null {
  switch (rule.field) {
    case RuleField.SenderAddress:
      return input.senderAddress;
    case RuleField.SenderDomain: {
      const at = input.senderAddress.lastIndexOf("@");
      return at === -1 ? null : input.senderAddress.slice(at + 1);
    }
    case RuleField.Subject:
      return input.subject;
    case RuleField.ListId:
      return input.listId;
  }
}

/** True when the rule matches. Never throws: a rule whose stored pattern
 * has become invalid (or matches a null field) simply does not match --
 * ingest must not lose mail to a bad rule. */
export function ruleMatches(
  rule: ClassificationRule,
  input: RuleMatchInput,
): boolean {
  if (!rule.enabled) {
    return false;
  }
  const raw = fieldValue(rule, input);
  if (raw === null) {
    return false;
  }
  const value = raw.slice(0, MAX_INPUT_LENGTH);
  switch (rule.matcher) {
    case RuleMatcher.Exact:
      return value.toLowerCase() === rule.pattern.toLowerCase();
    case RuleMatcher.Contains:
      return value.toLowerCase().includes(rule.pattern.toLowerCase());
    case RuleMatcher.Regex:
      try {
        return compileRulePattern(rule.pattern).test(value);
      } catch {
        return false;
      }
  }
}
