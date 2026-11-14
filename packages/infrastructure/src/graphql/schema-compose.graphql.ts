/**
 * The compose and forwarding additions to the GraphQL mail contract.
 * `SaveDraftInput.attachmentIds` is the complete set of the draft's own
 * attachments after a save. Every `forwardAttachmentIds` value must belong
 * to `forwardedFromMessageId`.
 */
export const composeTypeDefs = /* GraphQL */ `
  enum ComposeMode {
    REPLY
    REPLY_ALL
    FORWARD
  }

  extend input SendMessageInput {
    replyTo: String
    forwardedFromMessageId: ID
    "Each id must belong to forwardedFromMessageId."
    forwardAttachmentIds: [ID!]
  }

  # SaveDraftInput.attachmentIds is the complete set of the draft's own
  # attachments after this save; it is defined by the base input.
  extend input SaveDraftInput {
    replyTo: String
    forwardedFromMessageId: ID
    "Each id must belong to forwardedFromMessageId."
    forwardAttachmentIds: [ID!]
  }

  extend type Message {
    replyTo: String
    forwardedFromMessageId: ID
  }

  extend type Viewer {
    "ACTIVE provisioned addresses the viewer may MAIL_READ, across all domains."
    readableAddresses: [String!]!
  }

  type ComposePrefill {
    from: String
    to: [String!]!
    cc: [String!]!
    subject: String!
    inReplyToMessageId: ID
    forwardedFromMessageId: ID
    forwardAttachments: [Attachment!]!
    quotedText: String!
    quotedHtml: String
  }

  type MailLimits {
    maxAttachmentBytes: Int!
    maxOutboundTotalBytes: Int!
    maxAttachmentsPerMessage: Int!
    maxRecipientsPerMessage: Int!
  }

  extend type Query {
    composeFromMessage(messageId: ID!, mode: ComposeMode!): ComposePrefill!
    mailLimits: MailLimits!
  }

  extend type Mutation {
    deleteDraft(id: ID!): Boolean!
  }
`;
