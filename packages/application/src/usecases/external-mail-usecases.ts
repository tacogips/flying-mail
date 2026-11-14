import type { ExternalMailAccount } from "@flying-mail/domain/entities/external-mail-account";
import type { ExternalAccountId } from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import type { Viewer } from "../policies/viewer";
import {
  type CreateExternalAccountInput,
  createCreateExternalAccountUseCase,
  createDeleteExternalAccountUseCase,
  createListExternalAccountsUseCase,
  createTestExternalAccountUseCase,
  createUpdateExternalAccountUseCase,
  type ExternalAccountTestResult,
  type UpdateExternalAccountInput,
} from "./external-accounts";
import {
  createFetchExternalMailUseCase,
  type FetchExternalMailInput,
  type FetchExternalMailSummary,
} from "./external-fetch";
import type { ReceiveMessageInput, ReceiveMessageResult } from "./ingest";

/** The external-mail half of `UseCases`, assembled here so `usecases.ts`
 * gains a single spread rather than another feature's worth of entries. */
export interface ExternalMailUseCases {
  readonly listExternalAccounts: (
    viewer: Viewer,
  ) => Promise<readonly ExternalMailAccount[]>;
  readonly createExternalAccount: (
    viewer: Viewer,
    input: CreateExternalAccountInput,
  ) => Promise<ExternalMailAccount>;
  readonly updateExternalAccount: (
    viewer: Viewer,
    id: ExternalAccountId,
    input: UpdateExternalAccountInput,
  ) => Promise<ExternalMailAccount>;
  readonly deleteExternalAccount: (
    viewer: Viewer,
    id: ExternalAccountId,
  ) => Promise<boolean>;
  readonly testExternalAccount: (
    viewer: Viewer,
    id: ExternalAccountId,
  ) => Promise<ExternalAccountTestResult>;
  readonly fetchExternalMail: (
    viewer: Viewer,
    accountId: ExternalAccountId,
    input?: FetchExternalMailInput,
  ) => Promise<FetchExternalMailSummary>;
}

/** `receiveMessage` is accepted rather than built here, so
 * `createUseCases` can pass the one instance it already constructs for
 * `UseCases.receiveMessage` -- the same pattern `sendTemplatedMessage`
 * reuses `sendMessage` under. */
export function createExternalMailUseCases(
  deps: AppDependencies,
  receiveMessage: (input: ReceiveMessageInput) => Promise<ReceiveMessageResult>,
): ExternalMailUseCases {
  return {
    listExternalAccounts: createListExternalAccountsUseCase(deps),
    createExternalAccount: createCreateExternalAccountUseCase(deps),
    updateExternalAccount: createUpdateExternalAccountUseCase(deps),
    deleteExternalAccount: createDeleteExternalAccountUseCase(deps),
    testExternalAccount: createTestExternalAccountUseCase(deps),
    fetchExternalMail: createFetchExternalMailUseCase(deps, receiveMessage),
  };
}

export type {
  CreateExternalAccountInput,
  ExternalAccountTestResult,
  FetchExternalMailInput,
  FetchExternalMailSummary,
  UpdateExternalAccountInput,
};
