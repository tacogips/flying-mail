import type {
  MessageFilterVariables,
  SystemTagSlug,
  TagView,
} from "../api/schema-types";
import { parseSearchQuery, searchToFilterVariables } from "./search-query";

/** The mailbox view the sidebar selects. Kept as a small union rather than
 * free-form query params so a bookmarked URL always maps to a known view. */
export type MailboxView =
  | { readonly kind: "INBOX" }
  | { readonly kind: "SENT" }
  | { readonly kind: "DRAFTS" }
  | { readonly kind: "SPAM" }
  | { readonly kind: "STARRED" }
  | { readonly kind: "ARCHIVED" }
  | { readonly kind: "TRASH" }
  | { readonly kind: "ADDRESS"; readonly address: string }
  | { readonly kind: "TAG"; readonly tagId: string; readonly name: string }
  | { readonly kind: "SEARCH"; readonly query: string };

const SLUG_VIEWS: Readonly<Record<string, SystemTagSlug>> = {
  STARRED: "STARRED",
  ARCHIVED: "ARCHIVED",
  TRASH: "TRASH",
};

/** Translates a sidebar selection into the server-side filter.
 *
 * `INBOX` is inbound mail with spam excluded (the API's default); `SENT` is
 * outbound. A system-tag view filters on the slug, which also opts that
 * view into showing spam -- otherwise the Spam folder would be empty.
 *
 * A search view is parsed through the operator syntax (`from:`, `to:`,
 * `cc:`, `has:attachment`, `kind:`, `tag:`, `is:unread`, `in:spam`, plus
 * free text -- see `search-query.ts`), with tag names resolved against the
 * loaded tag list. */
export function viewToFilter(
  view: MailboxView,
  tags: readonly TagView[] = [],
): MessageFilterVariables {
  switch (view.kind) {
    case "INBOX":
      return { direction: "INBOUND" };
    case "SENT":
      // Drafts are outbound too; without the status filter they would sit
      // in Sent looking like dispatched mail.
      return { direction: "OUTBOUND", statuses: ["SENT"] };
    case "DRAFTS":
      return { statuses: ["DRAFT"] };
    case "SPAM":
      // Spam is a verdict table now, not a tag.
      return { spamOnly: true };
    case "STARRED":
    case "ARCHIVED":
    case "TRASH": {
      const slug = SLUG_VIEWS[view.kind];
      return slug === undefined ? {} : { systemSlugs: [slug] };
    }
    case "ADDRESS":
      return { toAddress: view.address };
    case "TAG":
      return { tagIds: [view.tagId] };
    case "SEARCH": {
      const variables = searchToFilterVariables(
        parseSearchQuery(view.query),
        tags,
      );
      // Unless the query narrows spam explicitly, search spans it: someone
      // hunting for a message wants it found wherever it was filed.
      return { includeSpam: true, ...variables };
    }
  }
}

/** Serializes a view into URL search params, so a mailbox is linkable. */
export function viewToSearchParams(view: MailboxView): URLSearchParams {
  const params = new URLSearchParams();
  params.set("view", view.kind);
  if (view.kind === "ADDRESS") {
    params.set("address", view.address);
  }
  if (view.kind === "TAG") {
    params.set("tag", view.tagId);
    params.set("name", view.name);
  }
  if (view.kind === "SEARCH") {
    params.set("q", view.query);
  }
  return params;
}

/** Parses URL search params back into a view, falling back to the inbox for
 * anything unrecognized rather than rendering an empty screen. */
export function searchParamsToView(params: URLSearchParams): MailboxView {
  const kind = params.get("view");
  switch (kind) {
    case "DRAFTS":
      return { kind: "DRAFTS" };
    case "SENT":
      return { kind: "SENT" };
    case "SPAM":
      return { kind: "SPAM" };
    case "STARRED":
      return { kind: "STARRED" };
    case "ARCHIVED":
      return { kind: "ARCHIVED" };
    case "TRASH":
      return { kind: "TRASH" };
    case "ADDRESS": {
      const address = params.get("address");
      return address === null
        ? { kind: "INBOX" }
        : { kind: "ADDRESS", address };
    }
    case "TAG": {
      const tagId = params.get("tag");
      return tagId === null
        ? { kind: "INBOX" }
        : { kind: "TAG", tagId, name: params.get("name") ?? "Tag" };
    }
    case "SEARCH": {
      const query = params.get("q");
      return query === null ? { kind: "INBOX" } : { kind: "SEARCH", query };
    }
    default:
      return { kind: "INBOX" };
  }
}

export function viewTitle(view: MailboxView): string {
  switch (view.kind) {
    case "INBOX":
      return "Inbox";
    case "SENT":
      return "Sent";
    case "DRAFTS":
      return "Drafts";
    case "SPAM":
      return "Spam";
    case "STARRED":
      return "Starred";
    case "ARCHIVED":
      return "Archived";
    case "TRASH":
      return "Trash";
    case "ADDRESS":
      return view.address;
    case "TAG":
      return view.name;
    case "SEARCH":
      return `Search: ${view.query}`;
  }
}
