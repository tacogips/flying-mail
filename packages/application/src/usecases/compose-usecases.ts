import { assertCanSendMail } from "@flying-mail/domain/entities/mail-domain";
import { MailStatus } from "@flying-mail/domain/entities/message";
import type { MessageId } from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, NotFoundError } from "../errors";
import type { Viewer } from "../policies/viewer";
import { getMailLimits, type MailLimits } from "./mail-limits";
import {
  computeComposePrefill,
  type ComposeMode,
  type ComposePrefill,
} from "./compose-prefill";
import { loadReadableMessage } from "./messages";
import { createListReadableAddressesUseCase } from "./readable-addresses";
import {
  createListAddressActivityUseCase,
  type AddressActivity,
} from "./address-activity";
import { createListSendableAddressesUseCase } from "./send";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

export interface ComposeUseCases {
  readonly composeFromMessage: (
    viewer: Viewer,
    messageId: MessageId,
    mode: ComposeMode,
  ) => Promise<ComposePrefill>;
  readonly listReadableAddresses: (
    viewer: Viewer,
  ) => Promise<readonly string[]>;
  readonly listAddressActivity: (
    viewer: Viewer,
  ) => Promise<readonly AddressActivity[]>;
  readonly getMailLimits: () => MailLimits;
}

export function createComposeUseCases(deps: AppDependencies): ComposeUseCases {
  const listReadableAddresses = createListReadableAddressesUseCase(deps);
  const listAddressActivity = createListAddressActivityUseCase(deps);
  const listSendableAddresses = createListSendableAddressesUseCase(deps);

  return {
    composeFromMessage: (viewer, messageId, mode) =>
      withAsyncDomainErrorTranslation(async () => {
        const message = await loadReadableMessage(deps, viewer, messageId);
        if (message === null) {
          throw new NotFoundError("Message", messageId);
        }
        if (message.status === MailStatus.Draft) {
          throw new BadUserInputError(
            "Cannot reply to or forward a draft",
            "messageId",
          );
        }
        const [recipientsByMessage, attachmentsByMessage, sendable] =
          await Promise.all([
            deps.messageRepository.listRecipients([message.id]),
            deps.messageRepository.listAttachments([message.id]),
            listSendableAddresses(viewer),
          ]);
        let expandedSendable = sendable;
        if (sendable.some((address) => address.trim() === "*")) {
          const wildcardPatterns = new Set<string>();
          for (const domain of await deps.mailDomainRepository.list()) {
            try {
              assertCanSendMail(domain);
              wildcardPatterns.add(`*@${domain.name}`);
            } catch {
              // A domain the viewer cannot send from is not an own address.
            }
          }
          expandedSendable = [
            ...new Set(
              sendable.flatMap((address) =>
                address.trim() === "*" ? [...wildcardPatterns] : [address],
              ),
            ),
          ];
        }
        return computeComposePrefill(
          {
            message,
            recipients: recipientsByMessage.get(message.id) ?? [],
            attachments: attachmentsByMessage.get(message.id) ?? [],
          },
          mode,
          expandedSendable,
        );
      }),
    listReadableAddresses: (viewer) =>
      withAsyncDomainErrorTranslation(() => listReadableAddresses(viewer)),
    listAddressActivity: (viewer) =>
      withAsyncDomainErrorTranslation(() => listAddressActivity(viewer)),
    getMailLimits,
  };
}
