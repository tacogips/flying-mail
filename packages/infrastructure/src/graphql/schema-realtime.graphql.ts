/** GraphQL contract for durable mail-event subscriptions. */
export const realtimeTypeDefs = /* GraphQL */ `
  enum MailEventType {
    MESSAGE_RECEIVED
    MESSAGE_SENT
    MESSAGE_UPDATED
    MESSAGE_DELETED
    DRAFT_SAVED
    DRAFT_DELETED
    LIVE
  }

  """A filter only; a scope does not grant access to mail."""
  input MailEventScope {
    domainId: ID
    address: String
  }

  type MailEvent {
    cursor: String!
    type: MailEventType!
    messageId: ID
    domainId: ID
    addresses: [String!]!
    occurredAt: DateTime!
    """Null when the message is deleted, unreadable, or this is a LIVE event."""
    message: Message
  }

  type Subscription {
    mailEvents(scope: MailEventScope, after: String): MailEvent!
  }
`;
