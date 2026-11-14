/**
 * Every calendar GraphQL document the client sends. A separate module from
 * `documents.ts` so neither file has to carry two features' worth of
 * queries.
 */

const EVENT_FIELDS = `
  id
  calendarId
  uid
  title
  description
  location
  time { allDay startsAt endsAt timeZone startDate endDateExclusive }
  recurrence { freq interval count until byDay byMonthDay byMonth weekStart }
  exdates
  overrideOfEventId
  recurrenceInstanceStart
  mentions
  links { id url title position }
  attachments { id fileName contentType size url }
  createdAt
  updatedAt
`;

const CALENDAR_FIELDS = `
  id
  ownerUserId
  name
  color
  description
  createdAt
  updatedAt
`;

export const CALENDARS_QUERY = `
  query Calendars { calendars { ${CALENDAR_FIELDS} } }
`;

export const CALENDAR_EVENTS_QUERY = `
  query CalendarEvents($input: CalendarEventRangeInput!) {
    calendarEvents(input: $input) {
      truncated
      occurrences {
        occurrenceStart
        startsAt
        endsAt
        isOverride
        event { ${EVENT_FIELDS} }
      }
    }
  }
`;

export const CALENDAR_EVENT_QUERY = `
  query CalendarEvent($id: ID!) {
    calendarEvent(id: $id) { ${EVENT_FIELDS} }
  }
`;

export const EVENTS_MENTIONING_QUERY = `
  query EventsMentioning($address: String!, $rangeStart: DateTime, $rangeEnd: DateTime) {
    eventsMentioning(address: $address, rangeStart: $rangeStart, rangeEnd: $rangeEnd) {
      ${EVENT_FIELDS}
    }
  }
`;

export const CREATE_CALENDAR_MUTATION = `
  mutation CreateCalendar($input: CreateCalendarInput!) {
    createCalendar(input: $input) { ${CALENDAR_FIELDS} }
  }
`;

export const UPDATE_CALENDAR_MUTATION = `
  mutation UpdateCalendar($id: ID!, $input: UpdateCalendarInput!) {
    updateCalendar(id: $id, input: $input) { ${CALENDAR_FIELDS} }
  }
`;

export const DELETE_CALENDAR_MUTATION = `
  mutation DeleteCalendar($id: ID!) { deleteCalendar(id: $id) }
`;

export const CREATE_CALENDAR_EVENT_MUTATION = `
  mutation CreateCalendarEvent($input: CreateCalendarEventInput!) {
    createCalendarEvent(input: $input) { ${EVENT_FIELDS} }
  }
`;

export const UPDATE_CALENDAR_EVENT_MUTATION = `
  mutation UpdateCalendarEvent($id: ID!, $input: UpdateCalendarEventInput!) {
    updateCalendarEvent(id: $id, input: $input) { ${EVENT_FIELDS} }
  }
`;

export const DELETE_CALENDAR_EVENT_MUTATION = `
  mutation DeleteCalendarEvent($id: ID!, $input: DeleteCalendarEventInput) {
    deleteCalendarEvent(id: $id, input: $input)
  }
`;

export const ADD_EVENT_MENTION_MUTATION = `
  mutation AddEventMention($eventId: ID!, $address: String!) {
    addEventMention(eventId: $eventId, address: $address) { ${EVENT_FIELDS} }
  }
`;

export const REMOVE_EVENT_MENTION_MUTATION = `
  mutation RemoveEventMention($eventId: ID!, $address: String!) {
    removeEventMention(eventId: $eventId, address: $address) { ${EVENT_FIELDS} }
  }
`;

export const ADD_EVENT_LINK_MUTATION = `
  mutation AddEventLink($eventId: ID!, $input: EventLinkInput!) {
    addEventLink(eventId: $eventId, input: $input) { ${EVENT_FIELDS} }
  }
`;

export const REMOVE_EVENT_LINK_MUTATION = `
  mutation RemoveEventLink($eventId: ID!, $linkId: ID!) {
    removeEventLink(eventId: $eventId, linkId: $linkId) { ${EVENT_FIELDS} }
  }
`;

export const ATTACH_FILE_TO_EVENT_MUTATION = `
  mutation AttachFileToEvent($eventId: ID!, $attachmentId: ID!) {
    attachFileToEvent(eventId: $eventId, attachmentId: $attachmentId) {
      id fileName contentType size url
    }
  }
`;

export const DETACH_FILE_FROM_EVENT_MUTATION = `
  mutation DetachFileFromEvent($eventId: ID!, $attachmentId: ID!) {
    detachFileFromEvent(eventId: $eventId, attachmentId: $attachmentId)
  }
`;

const CALDAV_ACCOUNT_FIELDS = `
  id
  userId
  serverUrl
  username
  principalUrl
  homeSetUrl
  createdAt
  updatedAt
`;

export const CALDAV_ACCOUNTS_QUERY = `
  query CaldavAccounts { caldavAccounts { ${CALDAV_ACCOUNT_FIELDS} } }
`;

export const CALDAV_CALENDARS_QUERY = `
  query CaldavCalendars($accountId: ID!) {
    caldavCalendars(accountId: $accountId) {
      id accountId calendarId remoteUrl displayName ctag syncToken lastSyncedAt
    }
  }
`;

export const CONNECT_CALDAV_ACCOUNT_MUTATION = `
  mutation ConnectCaldavAccount($input: ConnectCaldavAccountInput!) {
    connectCaldavAccount(input: $input) {
      account { ${CALDAV_ACCOUNT_FIELDS} }
      calendars { remoteUrl displayName ctag syncToken }
    }
  }
`;

export const LINK_CALDAV_CALENDAR_MUTATION = `
  mutation LinkCaldavCalendar($input: LinkCaldavCalendarInput!) {
    linkCaldavCalendar(input: $input) {
      id accountId calendarId remoteUrl displayName ctag syncToken lastSyncedAt
    }
  }
`;

export const SYNC_CALENDAR_MUTATION = `
  mutation SyncCalendar($calendarId: ID!) {
    syncCalendar(calendarId: $calendarId) {
      pulled pushed deleted conflictsResolvedRemoteWins truncated warnings
    }
  }
`;

export const DELETE_CALDAV_ACCOUNT_MUTATION = `
  mutation DeleteCaldavAccount($id: ID!) { deleteCaldavAccount(id: $id) }
`;
