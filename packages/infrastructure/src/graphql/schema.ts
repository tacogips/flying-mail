import type { GraphQLSchema } from "graphql";
import { createSchema, createYoga } from "graphql-yoga";
import type { GraphQLContext } from "./context";
import { useDepthLimit } from "./depth-limit";
import { calendarTypeDefs } from "./schema-calendar.graphql";
import { templateTypeDefs } from "./schema-templates.graphql";
import { typeDefs } from "./schema.graphql";
import { toGraphQLError } from "./errors";
import { calendarMutationResolvers } from "./resolvers/calendar-mutation";
import { calendarQueryResolvers } from "./resolvers/calendar-query";
import {
  calendarEventResolvers,
  eventOccurrenceResolvers,
} from "./resolvers/calendar-types";
import { mutationResolvers } from "./resolvers/mutation";
import { queryResolvers } from "./resolvers/query";
import {
  apiKeyResolvers,
  apiKeyScopeResolvers,
  apiKeyWithSecretResolvers,
  attachmentResolvers,
  fileLinkResolvers,
  mailDomainResolvers,
  messageResolvers,
  tagResolvers,
  classificationRuleResolvers,
  messageEventResolvers,
  threadResolvers,
  userMailPermissionResolvers,
  userResolvers,
  viewerResolvers,
} from "./resolvers/types";
import {
  mailAddressMutationResolvers,
  mailAddressQueryResolvers,
  mailAddressResolvers,
} from "./resolvers/mail-addresses";
import {
  mailTemplateResolvers,
  templateMutationResolvers,
  templateQueryResolvers,
} from "./resolvers/templates";
import { useSelectionLimit } from "./selection-limit";

/** Merges the SDL with every resolver module into an executable schema.
 *
 * `MailboxAddress`, `DnsRecord`, `MessagePage`, `AuthPayload` and
 * `CreatedFileLink` need no dedicated resolvers: their fields are plain
 * property access on the objects the use cases already return.
 * `BootstrapPayload` reuses `ApiKeyWithSecret`'s resolvers -- both carry an
 * `apiKey` plus a one-time `secret`, and `user` is plain property access.
 * `User` does need resolvers now: `active` is computed and `permissions` is
 * loader-based, mirroring `ApiKey.scopes`. */
export function buildGraphQLSchema(): GraphQLSchema {
  return createSchema<GraphQLContext>({
    // Three SDL documents, merged by `createSchema`: the mail and admin
    // contract, which defines Query/Mutation, plus the calendar and template
    // modules that `extend` them. No file has to carry another feature's
    // shapes, and none of them approaches the size ceiling.
    typeDefs: [typeDefs, calendarTypeDefs, templateTypeDefs],
    resolvers: {
      Query: {
        ...queryResolvers,
        ...mailAddressQueryResolvers,
        ...templateQueryResolvers,
        ...calendarQueryResolvers,
      },
      Mutation: {
        ...mutationResolvers,
        ...mailAddressMutationResolvers,
        ...templateMutationResolvers,
        ...calendarMutationResolvers,
      },
      MailAddress: mailAddressResolvers,
      MailTemplate: mailTemplateResolvers,
      CalendarEvent: calendarEventResolvers,
      EventOccurrence: eventOccurrenceResolvers,
      Message: messageResolvers,
      MailDomain: mailDomainResolvers,
      Tag: tagResolvers,
      Attachment: attachmentResolvers,
      ApiKey: apiKeyResolvers,
      ApiKeyScope: apiKeyScopeResolvers,
      ApiKeyWithSecret: apiKeyWithSecretResolvers,
      BootstrapPayload: apiKeyWithSecretResolvers,
      FileLink: fileLinkResolvers,
      Thread: threadResolvers,
      ClassificationRule: classificationRuleResolvers,
      MessageEvent: messageEventResolvers,
      Viewer: viewerResolvers,
      User: userResolvers,
      UserMailPermission: userMailPermissionResolvers,
    },
  });
}

/** Wraps the schema in a fetch-native graphql-yoga server.
 *
 * Every thrown value goes through `toGraphQLError` via yoga's
 * `maskedErrors.maskError` hook, so `extensions.code` is always present and
 * an unrecognized error is always masked. The two limit plugins reject
 * pathological documents before execution -- this endpoint is exposed to
 * untrusted agents. */
export function createGraphQLYoga(
  schema: GraphQLSchema,
  options: { graphiql: boolean },
): ReturnType<typeof createYoga<Record<string, unknown>, GraphQLContext>> {
  return createYoga<Record<string, unknown>, GraphQLContext>({
    schema,
    graphiql: options.graphiql,
    // The caller resolves the viewer, builds a full `GraphQLContext`, and
    // passes it as the extra server-context argument to
    // `yoga.fetch(request, context)`; it flows through unchanged here.
    context: (initialContext) => initialContext as unknown as GraphQLContext,
    plugins: [useDepthLimit(), useSelectionLimit()],
    maskedErrors: {
      maskError: (error) => toGraphQLError(error),
    },
  });
}
