import type { AttachmentKind, MailStatus, TagView } from "../api/schema-types";

/**
 * The search box speaks a small operator syntax, so one input covers every
 * filter dimension the API offers without a filter-builder UI:
 *
 *   from:alice@example.com      sender
 *   to:support@example.com      recipient, cc NOT included
 *   cc:copied@example.com       recipient, cc (and bcc) included
 *   has:attachment              only messages with attachments
 *   no:attachment               only messages without
 *   kind:pdf                    attachment kind (repeatable; or kind:pdf,image)
 *   tag:Invoices                tag by name (quote names with spaces)
 *   is:unread                   unread only
 *   is:list                     mailing-list messages only
 *   is:draft                    drafts only (also status:draft|sent|received)
 *   list:<id>                   exact List-Id match
 *   in:spam                     include spam in the results
 *   anything else               full-text over subject, snippet and body
 *
 * Everything unrecognized falls through to free text rather than erroring:
 * a search box that rejects input is worse than one that searches for it.
 */

export interface ParsedSearchQuery {
  readonly text: string;
  readonly from: string | null;
  /** `to:` -- recipient with cc excluded. */
  readonly toAddress: string | null;
  /** `cc:` -- recipient with cc included. */
  readonly recipientAddress: string | null;
  readonly hasAttachment: boolean | null;
  readonly attachmentKinds: readonly AttachmentKind[];
  readonly tagNames: readonly string[];
  readonly unreadOnly: boolean;
  readonly includeSpam: boolean;
  readonly mailingList: boolean | null;
  readonly statuses: readonly MailStatus[];
  readonly listId: string | null;
}

const EMPTY: ParsedSearchQuery = {
  text: "",
  from: null,
  toAddress: null,
  recipientAddress: null,
  hasAttachment: null,
  attachmentKinds: [],
  tagNames: [],
  unreadOnly: false,
  includeSpam: false,
  mailingList: null,
  statuses: [],
  listId: null,
};

const KNOWN_KINDS: readonly AttachmentKind[] = [
  "IMAGE",
  "VIDEO",
  "AUDIO",
  "PDF",
  "DOCUMENT",
  "SPREADSHEET",
  "PRESENTATION",
  "ARCHIVE",
  "TEXT",
  "CALENDAR",
  "OTHER",
];

/** Splits on whitespace, keeping `key:"quoted value"` and `"quoted text"`
 * together. A lone unterminated quote is treated as a literal character
 * rather than swallowing the rest of the query. */
export function tokenizeSearchQuery(query: string): readonly string[] {
  const tokens: string[] = [];
  const pattern = /(?:[^\s"]+"[^"]*"|"[^"]*"|\S)+/g;
  for (const match of query.matchAll(pattern)) {
    tokens.push(match[0]);
  }
  return tokens;
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function parseKinds(value: string): readonly AttachmentKind[] {
  return value
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry): entry is AttachmentKind =>
      (KNOWN_KINDS as readonly string[]).includes(entry),
    );
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
  let result: ParsedSearchQuery = EMPTY;
  const freeText: string[] = [];

  for (const token of tokenizeSearchQuery(query)) {
    const separator = token.indexOf(":");
    if (separator <= 0) {
      freeText.push(unquote(token));
      continue;
    }
    const key = token.slice(0, separator).toLowerCase();
    const value = unquote(token.slice(separator + 1));

    switch (key) {
      case "from":
        result = { ...result, from: value };
        break;
      case "to":
        result = { ...result, toAddress: value };
        break;
      case "cc":
      case "recipient":
        result = { ...result, recipientAddress: value };
        break;
      case "has":
        if (value.toLowerCase() === "attachment") {
          result = { ...result, hasAttachment: true };
        } else {
          freeText.push(token);
        }
        break;
      case "no":
        if (value.toLowerCase() === "attachment") {
          result = { ...result, hasAttachment: false };
        } else {
          freeText.push(token);
        }
        break;
      case "kind": {
        const kinds = parseKinds(value);
        if (kinds.length > 0) {
          result = {
            ...result,
            attachmentKinds: [...result.attachmentKinds, ...kinds],
          };
        } else {
          freeText.push(token);
        }
        break;
      }
      case "tag":
        if (value.length > 0) {
          result = { ...result, tagNames: [...result.tagNames, value] };
        }
        break;
      case "is": {
        const flag = value.toLowerCase();
        if (flag === "unread") {
          result = { ...result, unreadOnly: true };
        } else if (flag === "list") {
          result = { ...result, mailingList: true };
        } else if (flag === "draft") {
          result = { ...result, statuses: [...result.statuses, "DRAFT"] };
        } else {
          freeText.push(token);
        }
        break;
      }
      case "status": {
        const status = value.toUpperCase();
        if (status === "DRAFT" || status === "SENT" || status === "RECEIVED") {
          result = { ...result, statuses: [...result.statuses, status] };
        } else {
          freeText.push(token);
        }
        break;
      }
      case "list":
        if (value.length > 0) {
          result = { ...result, listId: value };
        }
        break;
      case "in":
        if (value.toLowerCase() === "spam") {
          result = { ...result, includeSpam: true };
        } else {
          freeText.push(token);
        }
        break;
      default:
        // An unknown operator is almost always ordinary text containing a
        // colon (a time, a URL); searching for it beats rejecting it.
        freeText.push(token);
    }
  }

  return { ...result, text: freeText.join(" ").trim() };
}

export interface SearchFilterVariables {
  readonly search?: string;
  readonly fromAddress?: string;
  readonly toAddress?: string;
  readonly recipientAddress?: string;
  readonly hasAttachment?: boolean;
  readonly attachmentKinds?: readonly AttachmentKind[];
  readonly tagIds?: readonly string[];
  readonly unreadOnly?: boolean;
  readonly includeSpam?: boolean;
  readonly mailingList?: boolean;
  readonly statuses?: readonly MailStatus[];
  readonly listId?: string;
}

/** Turns a parsed query into GraphQL filter variables. Tag names resolve
 * against the loaded tag list case-insensitively; a name that matches no
 * tag is folded back into the free text, so the search still returns
 * something explainable instead of silently filtering on nothing. */
export function searchToFilterVariables(
  parsed: ParsedSearchQuery,
  tags: readonly TagView[],
): SearchFilterVariables {
  const tagIds: string[] = [];
  const unresolved: string[] = [];
  for (const name of parsed.tagNames) {
    const tag = tags.find(
      (entry) => entry.name.toLowerCase() === name.toLowerCase(),
    );
    if (tag === undefined) {
      unresolved.push(name);
    } else {
      tagIds.push(tag.id);
    }
  }
  const text = [parsed.text, ...unresolved]
    .filter((s) => s.length > 0)
    .join(" ");

  return {
    ...(text.length > 0 ? { search: text } : {}),
    ...(parsed.from === null ? {} : { fromAddress: parsed.from }),
    ...(parsed.toAddress === null ? {} : { toAddress: parsed.toAddress }),
    ...(parsed.recipientAddress === null
      ? {}
      : { recipientAddress: parsed.recipientAddress }),
    ...(parsed.hasAttachment === null
      ? {}
      : { hasAttachment: parsed.hasAttachment }),
    ...(parsed.attachmentKinds.length > 0
      ? { attachmentKinds: parsed.attachmentKinds }
      : {}),
    ...(tagIds.length > 0 ? { tagIds } : {}),
    ...(parsed.unreadOnly ? { unreadOnly: true } : {}),
    ...(parsed.includeSpam ? { includeSpam: true } : {}),
    ...(parsed.mailingList === null ? {} : { mailingList: parsed.mailingList }),
    ...(parsed.statuses.length > 0 ? { statuses: parsed.statuses } : {}),
    ...(parsed.listId === null ? {} : { listId: parsed.listId }),
  };
}
