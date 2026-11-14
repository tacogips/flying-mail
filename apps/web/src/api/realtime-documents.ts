/** GraphQL documents used by the realtime web client. */
export const MAIL_EVENTS_SUBSCRIPTION = `
  subscription MailEvents($scope: MailEventScope, $after: String) {
    mailEvents(scope: $scope, after: $after) {
      cursor
      type
      messageId
      domainId
      addresses
      occurredAt
      message {
        id
        threadId
        direction
        subject
        snippet
        from { address name kind }
        recipients { address name kind }
        tags { id name color kind systemSlug messageCount }
        attachments { id fileName contentType size inline kind contentId url }
        isSpam
        spam { score markedBy markedAt }
        spamScore
        status
        listId
        isMailingList
        deliveryStatus
        deliveryError
        readAt
        fetchStatus
        occurredAt
        domain { id name }
      }
    }
  }
`;
