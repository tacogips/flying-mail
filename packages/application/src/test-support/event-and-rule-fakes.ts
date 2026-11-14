import type { ClassificationRule } from "@mailcal/domain/entities/classification-rule";
import type { MessageEvent } from "@mailcal/domain/entities/message-event";
import {
  type AddressPattern,
  matchAddressPattern,
} from "@mailcal/domain/value-objects/address-pattern";
import type { EmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  type MailPermissionFilter,
  mailPermissionFilterAuthorizesAnyAddress,
} from "../policies/authorization";
import type { ClassificationRuleRepository } from "../ports/classification-rule-repository";
import type { MessageEventRepository } from "../ports/message-event-repository";
import type { FakeMessageStores } from "./message-repository-fake";

export interface FakeEventStores {
  readonly events: Map<string, MessageEvent>;
}

export function createFakeEventStores(): FakeEventStores {
  return { events: new Map() };
}

/** Mirrors the SQL adapter's ordering: soonest due first, undated last. */
function byDue(a: MessageEvent, b: MessageEvent): number {
  if (a.dueAt === null && b.dueAt === null) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  if (a.dueAt === null) {
    return 1;
  }
  if (b.dueAt === null) {
    return -1;
  }
  return a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0;
}

export function createMessageEventRepositoryFake(
  stores: FakeEventStores,
  messageStores: FakeMessageStores,
): MessageEventRepository {
  // Both checks apply through the owning message, independently of each
  // other, mirroring `MessageEventListFilter.allowedPatterns` and
  // `.mailPermissionFilter` -- see message-repository-fake.ts's equivalent
  // pair for the message-listing case.
  const messageVisible = (
    messageId: string,
    allowedPatterns: readonly AddressPattern[] | null,
    mailPermissionFilter: MailPermissionFilter | null,
  ): boolean => {
    if (allowedPatterns === null && mailPermissionFilter === null) {
      return true;
    }
    const message = messageStores.messages.get(messageId);
    if (message === undefined) {
      return false;
    }
    const addresses: readonly EmailAddress[] = [
      message.fromAddress,
      ...(messageStores.recipients.get(messageId) ?? []).map(
        (recipient) => recipient.address,
      ),
    ];
    if (allowedPatterns !== null) {
      const matched = allowedPatterns.some((pattern) =>
        addresses.some((address) => matchAddressPattern(pattern, address)),
      );
      if (!matched) {
        return false;
      }
    }
    if (mailPermissionFilter !== null) {
      const matched = mailPermissionFilterAuthorizesAnyAddress(
        mailPermissionFilter,
        message.domainId,
        addresses,
      );
      if (!matched) {
        return false;
      }
    }
    return true;
  };

  return {
    async findById(id) {
      return stores.events.get(id) ?? null;
    },
    async save(event) {
      stores.events.set(event.id, event);
    },
    async delete(id) {
      stores.events.delete(id);
    },
    async listByMessages(ids) {
      const map = new Map<string, MessageEvent[]>();
      for (const event of [...stores.events.values()].sort(byDue)) {
        if ((ids as readonly string[]).includes(event.messageId)) {
          const list = map.get(event.messageId) ?? [];
          list.push(event);
          map.set(event.messageId, list);
        }
      }
      return map;
    },
    async list(filter, limit) {
      return [...stores.events.values()]
        .filter((event) => {
          if (filter.includeCompleted !== true && event.completedAt !== null) {
            return false;
          }
          if (
            filter.dueBefore !== undefined &&
            (event.dueAt === null || event.dueAt > filter.dueBefore)
          ) {
            return false;
          }
          if (
            filter.dueAfter !== undefined &&
            (event.dueAt === null || event.dueAt < filter.dueAfter)
          ) {
            return false;
          }
          return messageVisible(
            event.messageId,
            filter.allowedPatterns,
            filter.mailPermissionFilter,
          );
        })
        .sort(byDue)
        .slice(0, limit);
    },
  };
}

export interface FakeRuleStores {
  readonly rules: Map<string, ClassificationRule>;
}

export function createFakeRuleStores(): FakeRuleStores {
  return { rules: new Map() };
}

export function createClassificationRuleRepositoryFake(
  stores: FakeRuleStores,
): ClassificationRuleRepository {
  return {
    async findById(id) {
      return stores.rules.get(id) ?? null;
    },
    async save(rule) {
      stores.rules.set(rule.id, rule);
    },
    async delete(id) {
      stores.rules.delete(id);
    },
    async list() {
      return [...stores.rules.values()].sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : 1,
      );
    },
    async listEnabledForDomain(domainId) {
      return [...stores.rules.values()]
        .filter(
          (rule) =>
            rule.enabled &&
            (rule.domainId === null || rule.domainId === domainId),
        )
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    },
  };
}
