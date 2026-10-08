import {
  normalizeEventAddresses,
  type MailEventType,
  type NewMailEvent,
} from "@flying-mail/domain/entities/mail-event";
import type { Message } from "@flying-mail/domain/entities/message";
import type { MessageId } from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";

/**
 * Collects the sender and every recipient address with one repository call.
 */
export async function collectMailEventAddresses(
  deps: AppDependencies,
  messages: readonly Message[],
): Promise<ReadonlyMap<MessageId, readonly string[]>> {
  if (messages.length === 0) {
    return new Map();
  }
  const recipientsByMessage = await deps.messageRepository.listRecipients(
    messages.map((message) => message.id),
  );
  return new Map(
    messages.map((message) => {
      const recipients = recipientsByMessage.get(message.id) ?? [];
      return [
        message.id,
        normalizeEventAddresses([
          message.fromAddress,
          ...recipients.map((recipient) => recipient.address),
        ]),
      ];
    }),
  );
}

/**
 * Persists mail events after their owning state writes and pokes the live hub.
 * Failures are deliberately swallowed so event delivery never fails a mail mutation.
 */
export async function recordMailEvents(
  deps: AppDependencies,
  inputs: readonly {
    readonly type: MailEventType;
    readonly message: Message;
    readonly addresses?: readonly string[];
  }[],
): Promise<void> {
  if (inputs.length === 0) {
    return;
  }
  try {
    const missingAddresses = inputs.filter(
      (input) => input.addresses === undefined,
    );
    const collected = await collectMailEventAddresses(
      deps,
      missingAddresses.map((input) => input.message),
    );
    const events: NewMailEvent[] = inputs.map((input) => ({
      type: input.type,
      messageId: input.message.id,
      domainId: input.message.domainId,
      addresses: normalizeEventAddresses(
        input.addresses ?? collected.get(input.message.id) ?? [],
      ),
    }));
    const now = deps.clock.now();
    const occurredAt = now.toISOString();
    const retentionCutoff = new Date(
      now.getTime() - deps.instanceConfig.eventRetentionSeconds * 1000,
    ).toISOString();
    await deps.mailEventLog.append(events, { occurredAt, retentionCutoff });
    deps.mailEventNotifier.notify();
  } catch {
    console.error("Failed to record mail events", {
      count: inputs.length,
      types: inputs.map((input) => input.type),
    });
  }
}
