import type {
  CreateExternalAccountInput,
  ExternalAccountTestResult,
  FetchExternalMailSummary,
  UpdateExternalAccountInput,
} from "@flying-mail/application/usecases/external-mail-usecases";
import type {
  ExternalFetchInput,
  SmtpSubmissionInput,
  UpdateExternalFetchInput,
} from "@flying-mail/application/usecases/external-accounts";
import type {
  ExternalFetchConfig,
  ExternalMailAccount,
  ExternalAccountStatus,
} from "@flying-mail/domain/entities/external-mail-account";
import {
  createExternalAccountId,
  createMailAddressId,
} from "@flying-mail/domain/value-objects/ids";
import type { GraphQLContext } from "../context";
import { requireViewerOrThrow } from "./helpers";

/** Every external-mail query/mutation. Argument mapping only: authorization
 * (admin-only for every entry point but `fetchExternalMail`, MAIL_READ for
 * that one), credential-key gating and persistence all live behind
 * `ctx.usecases` -- mirrors `contact-mutation.ts`/`contact-query.ts`. No
 * secret is ever read back out of `ExternalMailAccount`: the use cases
 * return only the non-secret projection the SDL's type shape allows. */

interface ExternalFetchArg {
  readonly kind: "JMAP" | "POP3";
  readonly sessionUrl?: string | null;
  readonly host?: string | null;
  readonly port?: number | null;
  readonly username: string;
  readonly password: string;
}

interface CreateExternalMailAccountArg {
  readonly mailAddressId: string;
  readonly externalAddress: string;
  readonly displayName?: string | null;
  readonly fetch: ExternalFetchArg;
  readonly smtp?: SmtpSubmissionInput | null;
}

interface UpdateExternalMailAccountArg {
  readonly displayName?: string | null;
  readonly fetch?: ExternalFetchArg | null;
  readonly smtp?: SmtpSubmissionInput | null;
  readonly status?: ExternalAccountStatus | null;
}

/** Builds the create-time fetch config: `sessionUrl`/`host` default to an
 * empty string when the caller omits the field for the wrong kind (e.g.
 * `host` on a JMAP fetch), which the domain layer's own normalization
 * rejects with a clear `BAD_USER_INPUT` rather than this resolver
 * duplicating that validation. */
function toCreateFetchInput(arg: ExternalFetchArg): ExternalFetchInput {
  if (arg.kind === "JMAP") {
    return {
      kind: "JMAP",
      sessionUrl: arg.sessionUrl ?? "",
      username: arg.username,
      password: arg.password,
    };
  }
  return {
    kind: "POP3",
    host: arg.host ?? "",
    ...(arg.port == null ? {} : { port: arg.port }),
    username: arg.username,
    password: arg.password,
  };
}

/** Builds the update-time fetch patch. `username`/`password` are non-null in
 * the SDL's shared `ExternalFetchInput`, so an update always supplies both
 * rather than exercising the application layer's "omitted password keeps
 * the ciphertext" leniency for this field -- only `sessionUrl`/`host`/`port`
 * are genuinely optional here. */
function toUpdateFetchInput(arg: ExternalFetchArg): UpdateExternalFetchInput {
  if (arg.kind === "JMAP") {
    return {
      kind: "JMAP",
      username: arg.username,
      password: arg.password,
      ...(arg.sessionUrl == null ? {} : { sessionUrl: arg.sessionUrl }),
    };
  }
  return {
    kind: "POP3",
    username: arg.username,
    password: arg.password,
    ...(arg.host == null ? {} : { host: arg.host }),
    ...(arg.port == null ? {} : { port: arg.port }),
  };
}

export const externalMailQueryResolvers = {
  async externalMailAccounts(
    _parent: unknown,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<readonly ExternalMailAccount[]> {
    return ctx.usecases.listExternalAccounts(requireViewerOrThrow(ctx));
  },
};

export const externalMailMutationResolvers = {
  async createExternalMailAccount(
    _parent: unknown,
    args: { readonly input: CreateExternalMailAccountArg },
    ctx: GraphQLContext,
  ): Promise<ExternalMailAccount> {
    const input: CreateExternalAccountInput = {
      mailAddressId: createMailAddressId(args.input.mailAddressId),
      externalAddress: args.input.externalAddress,
      ...(args.input.displayName == null
        ? {}
        : { displayName: args.input.displayName }),
      fetch: toCreateFetchInput(args.input.fetch),
      ...(args.input.smtp == null ? {} : { smtp: args.input.smtp }),
    };
    return ctx.usecases.createExternalAccount(requireViewerOrThrow(ctx), input);
  },

  async updateExternalMailAccount(
    _parent: unknown,
    args: { readonly id: string; readonly input: UpdateExternalMailAccountArg },
    ctx: GraphQLContext,
  ): Promise<ExternalMailAccount> {
    // `smtp` and `displayName` distinguish an omitted field (no change) from
    // an explicit `null` (clear), so both use `=== undefined` rather than
    // the looser `== null` collapse the rest of this mapping uses -- the SDL
    // doc comment on `UpdateExternalMailAccountInput` calls this out
    // explicitly for `smtp`.
    const input: UpdateExternalAccountInput = {
      ...(args.input.displayName === undefined
        ? {}
        : { displayName: args.input.displayName }),
      ...(args.input.fetch == null
        ? {}
        : { fetch: toUpdateFetchInput(args.input.fetch) }),
      ...(args.input.smtp === undefined
        ? {}
        : { smtp: args.input.smtp === null ? null : args.input.smtp }),
      ...(args.input.status == null ? {} : { status: args.input.status }),
    };
    return ctx.usecases.updateExternalAccount(
      requireViewerOrThrow(ctx),
      createExternalAccountId(args.id),
      input,
    );
  },

  async deleteExternalMailAccount(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ): Promise<boolean> {
    return ctx.usecases.deleteExternalAccount(
      requireViewerOrThrow(ctx),
      createExternalAccountId(args.id),
    );
  },

  async testExternalMailAccount(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ): Promise<ExternalAccountTestResult> {
    return ctx.usecases.testExternalAccount(
      requireViewerOrThrow(ctx),
      createExternalAccountId(args.id),
    );
  },

  async fetchExternalMail(
    _parent: unknown,
    args: { readonly id: string; readonly max?: number | null },
    ctx: GraphQLContext,
  ): Promise<FetchExternalMailSummary> {
    return ctx.usecases.fetchExternalMail(
      requireViewerOrThrow(ctx),
      createExternalAccountId(args.id),
      args.max == null ? undefined : { max: args.max },
    );
  },
};

export const externalMailAccountResolvers = {
  /** Loader-based, so listing every external account stays one mail-address
   * lookup batch rather than one query per row -- mirrors
   * `mailAddressResolvers.domain`. */
  async mailAddress(
    account: ExternalMailAccount,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<string> {
    const mailAddress = await ctx.loaders.mailAddressById.load(
      account.mailAddressId,
    );
    if (mailAddress === null) {
      // Guaranteed by the schema's foreign key in a real deployment; thrown
      // defensively rather than returning a value that does not exist.
      throw new Error(
        `Mail address ${account.mailAddressId} not found for external account ${account.id}`,
      );
    }
    return mailAddress.address;
  },

  fetchKind(account: ExternalMailAccount): ExternalFetchConfig["kind"] {
    return account.fetch.kind;
  },

  smtpConfigured(account: ExternalMailAccount): boolean {
    return account.smtp !== null;
  },
};
