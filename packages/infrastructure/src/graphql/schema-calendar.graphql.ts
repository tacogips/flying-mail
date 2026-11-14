/**
 * The calendar and CalDAV half of the GraphQL contract, mirroring
 * `design-docs/specs/design-calendar.md#graphql-surface`.
 *
 * A separate SDL module rather than more lines in `schema.graphql.ts`:
 * that file is already at the repository's size ceiling, and the two
 * documents are merged by `createSchema` (which accepts an array), so the
 * split costs nothing at runtime.
 *
 * `UserCalendarPermission` and `User.calendarPermissions` deliberately live
 * in `schema.graphql.ts` beside their mail counterparts -- they are part of
 * the admin user-management surface, not of the calendar surface.
 *
 * There is no attendee, participation or RSVP field anywhere below. Mentions
 * are plain addresses; see the design doc's out-of-scope list.
 */
export const calendarTypeDefs = /* GraphQL */ `
  enum RecurrenceFrequency {
    DAILY
    WEEKLY
    MONTHLY
    YEARLY
  }

  enum Weekday {
    MO
    TU
    WE
    TH
    FR
    SA
    SU
  }

  """
  THIS_OCCURRENCE edits or removes a single instance of a series: updating
  writes an override, deleting appends an EXDATE. ENTIRE_SERIES rewrites the
  master itself.
  """
  enum EventEditScope {
    THIS_OCCURRENCE
    ENTIRE_SERIES
  }

  """
  IMPORT_NEW creates a fresh mailcal calendar for the remote collection;
  BIND_EXISTING attaches the remote collection to a calendar that already
  exists (and then requires calendarId).
  """
  enum CaldavLinkMode {
    IMPORT_NEW
    BIND_EXISTING
  }

  type Calendar {
    id: ID!
    ownerUserId: ID!
    name: String!
    "Lower-cased #rrggbb."
    color: String!
    description: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type EventLink {
    id: ID!
    url: String!
    title: String
    position: Int!
  }

  """
  The supported RFC 5545 RRULE subset. A remote rule outside it is imported
  as a single event and reported in SyncCalendarResult.warnings rather than
  approximated.
  """
  type RecurrenceRule {
    freq: RecurrenceFrequency!
    interval: Int!
    count: Int
    until: DateTime
    byDay: [Weekday!]
    byMonthDay: [Int!]
    byMonth: [Int!]
    weekStart: Weekday!
  }

  input RecurrenceRuleInput {
    freq: RecurrenceFrequency!
    interval: Int
    "Mutually exclusive with until."
    count: Int
    until: DateTime
    byDay: [Weekday!]
    byMonthDay: [Int!]
    byMonth: [Int!]
    weekStart: Weekday
  }

  """
  A timed event carries instants plus the IANA zone its wall-clock times were
  authored in; an all-day event carries dates and no zone at all.
  """
  type EventTime {
    allDay: Boolean!
    startsAt: DateTime
    endsAt: DateTime
    timeZone: String
    startDate: String
    endDateExclusive: String
  }

  input EventTimeInput {
    allDay: Boolean!
    "Required when allDay is false."
    startsAt: DateTime
    endsAt: DateTime
    "IANA identifier; defaults to UTC."
    timeZone: String
    "YYYY-MM-DD, required when allDay is true."
    startDate: String
    endDateExclusive: String
  }

  input EventLinkInput {
    url: String!
    title: String
  }

  type CalendarEvent {
    id: ID!
    calendarId: ID!
    calendar: Calendar
    "iCalendar UID; stable across CalDAV sync."
    uid: String!
    title: String!
    description: String
    location: String
    time: EventTime!
    recurrence: RecurrenceRule
    "Occurrence starts removed from the series, as ISO instants or dates."
    exdates: [String!]!
    "Set when this row overrides one instance of the series sharing its UID."
    overrideOfEventId: ID
    recurrenceInstanceStart: String
    """
    Mail addresses mentioned on this event. Plain addresses: mailcal tracks
    no attendance state of any kind.
    """
    mentions: [String!]!
    links: [EventLink!]!
    attachments: [Attachment!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """
  One generated instance of an event. A non-recurring event yields exactly
  one; a series yields one per occurrence in the queried range, with
  overridden instances substituted.
  """
  type EventOccurrence {
    event: CalendarEvent!
    "The series-relative identity of this instance (ISO instant or date)."
    occurrenceStart: String!
    startsAt: DateTime!
    endsAt: DateTime!
    isOverride: Boolean!
  }

  type EventOccurrencePage {
    occurrences: [EventOccurrence!]!
    "True when a series hit the per-event expansion cap and was cut short."
    truncated: Boolean!
  }

  input CalendarEventRangeInput {
    "Omitted or empty means every calendar the viewer may read."
    calendarIds: [ID!]
    rangeStart: DateTime!
    rangeEnd: DateTime!
    """
    When false, a series master is returned once at its own start instead of
    being expanded -- what a client editing the rule itself wants.
    """
    expand: Boolean = true
  }

  input CreateCalendarInput {
    name: String!
    color: String
    description: String
    "ADMIN only: create the calendar on behalf of another user."
    ownerUserId: ID
  }

  input UpdateCalendarInput {
    name: String
    color: String
    description: String
  }

  input CreateCalendarEventInput {
    calendarId: ID!
    title: String!
    description: String
    location: String
    time: EventTimeInput!
    recurrence: RecurrenceRuleInput
    mentions: [String!]
    links: [EventLinkInput!]
  }

  input UpdateCalendarEventInput {
    title: String
    description: String
    location: String
    time: EventTimeInput
    recurrence: RecurrenceRuleInput
    mentions: [String!]
    links: [EventLinkInput!]
    editScope: EventEditScope
    "Required with THIS_OCCURRENCE on a recurring series."
    occurrenceStart: String
  }

  input DeleteCalendarEventInput {
    editScope: EventEditScope
    occurrenceStart: String
  }

  """
  A connected CalDAV account. Neither the plaintext app-specific password nor
  its ciphertext is exposed here, by construction.
  """
  type CaldavAccount {
    id: ID!
    userId: ID!
    serverUrl: String!
    username: String!
    principalUrl: String
    homeSetUrl: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  "A remote collection found during discovery, not yet linked."
  type CaldavDiscoveredCalendar {
    remoteUrl: String!
    displayName: String
    ctag: String
    syncToken: String
  }

  "A local calendar bound to a remote collection."
  type CaldavCalendar {
    id: ID!
    accountId: ID!
    calendarId: ID!
    remoteUrl: String!
    displayName: String
    ctag: String
    syncToken: String
    lastSyncedAt: DateTime
  }

  type ConnectCaldavAccountResult {
    account: CaldavAccount!
    calendars: [CaldavDiscoveredCalendar!]!
  }

  type SyncCalendarResult {
    pulled: Int!
    pushed: Int!
    deleted: Int!
    "Both sides changed, or a PUT was refused: the remote version won."
    conflictsResolvedRemoteWins: Int!
    "True when the change set exceeded one request's budget; sync again."
    truncated: Boolean!
    "Time zones and recurrence rules the importer had to approximate."
    warnings: [String!]!
  }

  input ConnectCaldavAccountInput {
    serverUrl: String!
    username: String!
    "An iCloud app-specific password. Stored only as ciphertext."
    appPassword: String!
  }

  input LinkCaldavCalendarInput {
    accountId: ID!
    remoteUrl: String!
    mode: CaldavLinkMode!
    "Required for BIND_EXISTING."
    calendarId: ID
    displayName: String
  }

  extend type Query {
    calendars: [Calendar!]!
    calendar(id: ID!): Calendar
    "Server-side expansion, so agents and the web client see one answer."
    calendarEvents(input: CalendarEventRangeInput!): EventOccurrencePage!
    calendarEvent(id: ID!): CalendarEvent
    """
    Events mentioning a mail address. A USER may ask about its own address
    (an ADMIN about anyone's); an API key about an address one of its
    CALENDAR_READ scopes covers.
    """
    eventsMentioning(
      address: String!
      rangeStart: DateTime
      rangeEnd: DateTime
    ): [CalendarEvent!]!
    caldavAccounts: [CaldavAccount!]!
    caldavCalendars(accountId: ID!): [CaldavCalendar!]!
  }

  extend type Mutation {
    createCalendar(input: CreateCalendarInput!): Calendar!
    updateCalendar(id: ID!, input: UpdateCalendarInput!): Calendar!
    deleteCalendar(id: ID!): Boolean!

    createCalendarEvent(input: CreateCalendarEventInput!): CalendarEvent!
    updateCalendarEvent(
      id: ID!
      input: UpdateCalendarEventInput!
    ): CalendarEvent!
    deleteCalendarEvent(id: ID!, input: DeleteCalendarEventInput): Boolean!

    "Mention management addressed by mail address."
    addEventMention(eventId: ID!, address: String!): CalendarEvent!
    removeEventMention(eventId: ID!, address: String!): CalendarEvent!
    addEventLink(eventId: ID!, input: EventLinkInput!): CalendarEvent!
    removeEventLink(eventId: ID!, linkId: ID!): CalendarEvent!

    "Claims a staged upload from POST /api/attachments for an event."
    attachFileToEvent(eventId: ID!, attachmentId: ID!): [Attachment!]!
    detachFileFromEvent(eventId: ID!, attachmentId: ID!): Boolean!

    """
    Requires a USER viewer: an API key must not be able to rotate or
    exfiltrate a person's iCloud credentials.
    """
    connectCaldavAccount(
      input: ConnectCaldavAccountInput!
    ): ConnectCaldavAccountResult!
    linkCaldavCalendar(input: LinkCaldavCalendarInput!): CaldavCalendar!
    "On-demand sync. Conflicts resolve remote-wins, deterministically."
    syncCalendar(calendarId: ID!): SyncCalendarResult!
    deleteCaldavAccount(id: ID!): Boolean!
  }
`;
