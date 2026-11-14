import { Capability } from "@mailcal/domain/entities/api-key";
import {
  type ClassificationRule,
  createClassificationRule,
  ruleMatches,
  type RuleAction,
  RuleAction as RuleActionEnum,
  type RuleField,
  type RuleMatcher,
  setRuleEnabled,
} from "@mailcal/domain/entities/classification-rule";
import {
  type ClassificationRuleId,
  createClassificationRuleId,
  type DomainId,
  type TagId,
} from "@mailcal/domain/value-objects/ids";
import { MessageDirection } from "@mailcal/domain/entities/message";
import {
  createSpamMark,
  SpamMarkedBy,
} from "@mailcal/domain/entities/spam-mark";
import type { AppDependencies } from "../dependencies";
import { NotFoundError } from "../errors";
import { requireGlobalCapability } from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

export interface CreateRuleInput {
  readonly domainId?: DomainId | null;
  readonly field: RuleField;
  readonly matcher: RuleMatcher;
  readonly pattern: string;
  readonly action: RuleAction;
  readonly tagId?: TagId | null;
  readonly description?: string | null;
}

/** Rules rewrite how every inbound message on a domain is classified, so
 * they sit behind DOMAIN_ADMIN -- the capability that already governs
 * domain-wide ingest behaviour -- rather than MAIL_MANAGE. */
function requireRuleAdmin(viewer: Viewer): void {
  requireGlobalCapability(viewer, Capability.DomainAdmin);
}

async function requireTagExists(
  deps: AppDependencies,
  tagId: TagId | null,
): Promise<void> {
  if (tagId === null) {
    return;
  }
  const tags = await deps.tagRepository.findByIds([tagId]);
  if (tags.length === 0) {
    throw new NotFoundError("Tag", tagId);
  }
}

async function requireDomainExists(
  deps: AppDependencies,
  domainId: DomainId | null,
): Promise<void> {
  if (domainId === null) {
    return;
  }
  const domain = await deps.mailDomainRepository.findById(domainId);
  if (domain === null) {
    throw new NotFoundError("Domain", domainId);
  }
}

export function createCreateClassificationRuleUseCase(
  deps: AppDependencies,
): (viewer: Viewer, input: CreateRuleInput) => Promise<ClassificationRule> {
  return async (viewer, input) =>
    withAsyncDomainErrorTranslation(async () => {
      const domainId = input.domainId ?? null;
      requireRuleAdmin(viewer);
      await requireDomainExists(deps, domainId);
      const tagId =
        input.action === RuleActionEnum.Tag ? (input.tagId ?? null) : null;
      await requireTagExists(deps, tagId);
      const rule = createClassificationRule({
        id: createClassificationRuleId(deps.random.uuid()),
        domainId,
        field: input.field,
        matcher: input.matcher,
        pattern: input.pattern,
        action: input.action,
        tagId,
        description: input.description ?? null,
        createdAt: deps.clock.now().toISOString(),
      });
      await deps.classificationRuleRepository.save(rule);
      return rule;
    });
}

export function createSetClassificationRuleEnabledUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: ClassificationRuleId,
  enabled: boolean,
) => Promise<ClassificationRule> {
  return async (viewer, id, enabled) => {
    const rule = await deps.classificationRuleRepository.findById(id);
    if (rule === null) {
      throw new NotFoundError("ClassificationRule", id);
    }
    requireRuleAdmin(viewer);
    const updated = setRuleEnabled(
      rule,
      enabled,
      deps.clock.now().toISOString(),
    );
    await deps.classificationRuleRepository.save(updated);
    return updated;
  };
}

export function createDeleteClassificationRuleUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: ClassificationRuleId) => Promise<boolean> {
  return async (viewer, id) => {
    const rule = await deps.classificationRuleRepository.findById(id);
    if (rule === null) {
      throw new NotFoundError("ClassificationRule", id);
    }
    requireRuleAdmin(viewer);
    await deps.classificationRuleRepository.delete(id);
    return true;
  };
}

export interface RuleApplication {
  /** Messages inspected (bounded by the per-run cap). */
  readonly examined: number;
  /** Messages the rule matched and acted on. */
  readonly matched: number;
}

const APPLY_PAGE_SIZE = 200;
/** Per-run ceiling. A worker request cannot chew through an unbounded
 * mailbox; re-running continues from the top and already-marked messages
 * are naturally idempotent. */
const APPLY_MAX_EXAMINED = 5000;

/** Runs one rule over mail that already arrived -- the missing half of
 * rule-based classification: adding "this sender is spam" should be able
 * to clean up the past, not only the future. Inbound messages only,
 * newest first, evaluated with the same matcher the ingest path uses. */
export function createApplyClassificationRuleUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: ClassificationRuleId) => Promise<RuleApplication> {
  return async (viewer, id) => {
    const rule = await deps.classificationRuleRepository.findById(id);
    if (rule === null) {
      throw new NotFoundError("ClassificationRule", id);
    }
    requireRuleAdmin(viewer);

    const now = deps.clock.now().toISOString();
    let examined = 0;
    let matched = 0;
    let cursor: string | null = null;

    while (examined < APPLY_MAX_EXAMINED) {
      const page = await deps.messageRepository.list(
        {
          direction: MessageDirection.Inbound,
          ...(rule.domainId === null ? {} : { domainIds: [rule.domainId] }),
          allowedPatterns: null,
          // System-level sweep already gated by `requireRuleAdmin` above,
          // not a per-viewer mailbox read -- no mailbox-rule restriction.
          mailPermissionFilter: null,
        },
        APPLY_PAGE_SIZE,
        cursor,
      );
      const hits = page.nodes.filter((message) =>
        ruleMatches(rule, {
          senderAddress: message.fromAddress,
          subject: message.subject,
          listId: message.listId,
        }),
      );
      examined += page.nodes.length;
      matched += hits.length;

      if (hits.length > 0) {
        const hitIds = hits.map((message) => message.id);
        switch (rule.action) {
          case RuleActionEnum.Spam:
            await deps.messageRepository.setSpamMarks(
              hits.map((message) =>
                createSpamMark({
                  messageId: message.id,
                  score: message.spamScore,
                  markedBy: SpamMarkedBy.Rule,
                  markedAt: now,
                }),
              ),
            );
            break;
          case RuleActionEnum.MailingList:
            for (const message of hits) {
              if (!message.isMailingList) {
                await deps.messageRepository.save({
                  ...message,
                  isMailingList: true,
                  updatedAt: now,
                });
              }
            }
            break;
          case RuleActionEnum.Tag:
            if (rule.tagId !== null) {
              await deps.messageRepository.addTags(hitIds, [rule.tagId], now);
            }
            break;
        }
      }

      if (page.nextCursor === null) {
        break;
      }
      cursor = page.nextCursor;
    }

    return { examined, matched };
  };
}

export function createListClassificationRulesUseCase(
  deps: AppDependencies,
): (viewer: Viewer) => Promise<readonly ClassificationRule[]> {
  return async (viewer) => {
    requireRuleAdmin(viewer);
    return deps.classificationRuleRepository.list();
  };
}
