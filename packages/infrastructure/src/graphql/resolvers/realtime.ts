import { NotFoundError } from "@flying-mail/application/errors";
import { Capability } from "@flying-mail/domain/entities/api-key";
import {
  createDomainId,
  createMessageId,
} from "@flying-mail/domain/value-objects/ids";
import { parseEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import { authorizesAnyAddress } from "@flying-mail/application/policies/authorization";
import type { MailEventPayload } from "../../realtime/mail-event-payload";
import { badUserInputError } from "../errors";
import type { GraphQLContext } from "../context";

export const subscriptionResolvers = {
  mailEvents: {
    subscribe() {
      throw badUserInputError(
        "Subscriptions are served only over WebSocket (graphql-transport-ws) at /graphql",
      );
    },
    resolve(source: { readonly mailEvents: MailEventPayload }) {
      return source.mailEvents;
    },
  },
};

export const mailEventResolvers = {
  addresses(payload: MailEventPayload, _args: unknown, ctx: GraphQLContext) {
    const viewer = ctx.viewer;
    if (payload.type === "LIVE" || viewer === null) {
      return [];
    }
    const domainId = createDomainId(payload.domainId ?? "");
    return payload.addresses.filter((rawAddress) => {
      const address = parseEmailAddress(rawAddress);
      return (
        address !== null &&
        authorizesAnyAddress(viewer, Capability.MailRead, domainId, [address])
      );
    });
  },

  async message(
    payload: MailEventPayload,
    _args: unknown,
    ctx: GraphQLContext,
  ) {
    if (
      payload.type === "LIVE" ||
      payload.messageId === null ||
      ctx.viewer === null
    ) {
      return null;
    }
    try {
      return await ctx.usecases.getMessage(
        ctx.viewer,
        createMessageId(payload.messageId),
      );
    } catch (error) {
      if (error instanceof NotFoundError) {
        return null;
      }
      throw error;
    }
  },
};
