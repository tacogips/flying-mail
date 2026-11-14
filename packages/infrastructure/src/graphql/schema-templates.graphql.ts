/**
 * The mail-template half of the GraphQL contract, mirroring
 * `design-docs/specs/design-mail-templates.md`.
 *
 * A separate SDL module rather than more lines in `schema.graphql.ts`, for
 * the same reason `schema-calendar.graphql.ts` is one: that file reached the
 * repository's 1000-line ceiling, and `createSchema` accepts an array of
 * documents, so the split costs nothing at runtime.
 *
 * `TemplateCapability`, `UserTemplatePermission` and
 * `User.templatePermissions` deliberately stay in `schema.graphql.ts` beside
 * their mail and calendar counterparts -- they are part of the admin
 * user-management surface, not of the template surface itself.
 */
export const templateTypeDefs = /* GraphQL */ `
  enum TemplateVariableType {
    TEXT
    MULTILINE_TEXT
    NUMBER
    BOOLEAN
    DATE
    EMAIL
  }

  type TemplateVariable {
    key: String!
    label: String!
    type: TemplateVariableType!
    required: Boolean!
    defaultValue: String
    description: String
  }

  input TemplateVariableInput {
    key: String!
    label: String
    type: TemplateVariableType!
    required: Boolean
    defaultValue: String
    description: String
  }

  """
  A reusable mail body with declared variables. Rendering is parse-only (no
  runtime code generation), so a template can never execute anything.
  """
  type MailTemplate {
    id: ID!
    name: String!
    description: String
    subject: String!
    textBody: String
    htmlBody: String
    from: String
    to: [String!]!
    cc: [String!]!
    bcc: [String!]!
    variables: [TemplateVariable!]!
    "The variable keys the template body actually references."
    referencedVariableKeys: [String!]!
    createdByUserId: ID
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  input MailTemplateInput {
    name: String!
    description: String
    subject: String!
    textBody: String
    htmlBody: String
    from: String
    to: [String!]
    cc: [String!]
    bcc: [String!]
    variables: [TemplateVariableInput!]!
  }

  input TemplateValueInput {
    key: String!
    value: String!
  }

  type TemplateValueProblem {
    key: String!
    reason: String!
  }

  type TemplateValidation {
    valid: Boolean!
    missing: [String!]!
    invalid: [TemplateValueProblem!]!
    unknown: [String!]!
  }

  "The review step: rendered but not sent."
  type RenderedTemplate {
    subject: String!
    text: String
    html: String
    from: String
    to: [String!]!
    cc: [String!]!
    bcc: [String!]!
    validation: TemplateValidation!
  }

  input SendTemplatedMessageInput {
    templateId: ID!
    values: [TemplateValueInput!]!
    "Overrides the template's own recipients and sender when supplied."
    from: String
    to: [String!]
    cc: [String!]
    bcc: [String!]
    inReplyToMessageId: ID
    attachmentIds: [ID!]
    headers: [HeaderInput!]
    tagIds: [ID!]
  }

  extend type Query {
    mailTemplates: [MailTemplate!]!
    mailTemplate(id: ID!): MailTemplate
    "Checks a value set against a template's declared variables."
    mailTemplateValidation(
      id: ID!
      values: [TemplateValueInput!]!
    ): TemplateValidation!
    "Renders without sending."
    previewMailTemplate(
      id: ID!
      values: [TemplateValueInput!]!
    ): RenderedTemplate!
  }

  extend type Mutation {
    createMailTemplate(input: MailTemplateInput!): MailTemplate!
    updateMailTemplate(id: ID!, input: MailTemplateInput!): MailTemplate!
    deleteMailTemplate(id: ID!): Boolean!
    "Renders the template with these values and sends the result."
    sendTemplatedMessage(input: SendTemplatedMessageInput!): Message!
  }
`;
