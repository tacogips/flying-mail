/**
 * The external mail account half of the GraphQL contract, mirroring
 * `design-docs/specs/design-external-mail.md#graphql`.
 *
 * A separate SDL module keeps the external-account contract cohesive while
 * `createSchema` merges it with the other feature documents at runtime.
 *
 * `ExternalMailAccount` never exposes a secret, by type shape: there is no
 * `String` field named or typed for a plaintext password or a ciphertext,
 * so leaking one would require adding a field, not a resolver bug.
 */
export const externalMailTypeDefs = /* GraphQL */ `
  enum ExternalFetchKind {
    JMAP
    POP3
  }

  enum ExternalAccountStatus {
    ACTIVE
    DISABLED
  }

  enum SmtpSecurity {
    IMPLICIT_TLS
    STARTTLS
  }

  """
  A bound external mailbox. No secret -- neither a plaintext password nor a
  ciphertext -- is ever exposed here, by construction: the resolver reads
  only the non-secret projection the use case returns.
  """
  type ExternalMailAccount {
    id: ID!
    mailAddressId: ID!
    mailAddress: String!
    externalAddress: String!
    displayName: String
    fetchKind: ExternalFetchKind!
    "True when an SMTP submission config is set, without revealing it."
    smtpConfigured: Boolean!
    status: ExternalAccountStatus!
    lastFetchedAt: DateTime
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type ExternalAccountTestResult {
    fetchOk: Boolean!
    fetchError: String
    "Null when no SMTP relay is configured."
    smtpOk: Boolean
    smtpError: String
  }

  type ExternalFetchSummary {
    fetched: Int!
    skipped: Int!
    "True when the per-run cap was hit; call fetchExternalMail again."
    hasMore: Boolean!
  }

  input ExternalFetchInput {
    kind: ExternalFetchKind!
    "JMAP only."
    sessionUrl: String
    "POP3 only. Defaults to 995; any other port is rejected."
    host: String
    port: Int
    username: String!
    password: String!
  }

  input SmtpSubmissionInput {
    host: String!
    port: Int!
    security: SmtpSecurity!
    username: String!
    password: String!
  }

  input CreateExternalMailAccountInput {
    mailAddressId: ID!
    externalAddress: String!
    displayName: String
    fetch: ExternalFetchInput!
    smtp: SmtpSubmissionInput
  }

  """
  Every field is an optional patch. fetch/smtp with an omitted password keep
  the stored ciphertext (credential replacement re-enciphers only when a new
  password is given). smtp: null clears SMTP relay entirely.
  """
  input UpdateExternalMailAccountInput {
    displayName: String
    fetch: ExternalFetchInput
    smtp: SmtpSubmissionInput
    status: ExternalAccountStatus
  }

  extend type Query {
    "Admin-only, mirroring domains and other instance-wide settings."
    externalMailAccounts: [ExternalMailAccount!]!
  }

  extend type Mutation {
    createExternalMailAccount(
      input: CreateExternalMailAccountInput!
    ): ExternalMailAccount!
    updateExternalMailAccount(
      id: ID!
      input: UpdateExternalMailAccountInput!
    ): ExternalMailAccount!
    deleteExternalMailAccount(id: ID!): Boolean!
    "Connect + authenticate only; fetches or sends nothing."
    testExternalMailAccount(id: ID!): ExternalAccountTestResult!
    """
    On-demand fetch. Any viewer authorized for MAIL_READ on the bound
    address may call this, not admin-only.
    """
    fetchExternalMail(id: ID!, max: Int): ExternalFetchSummary!
  }
`;
