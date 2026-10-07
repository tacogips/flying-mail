import type {
  MailDomainView,
  MessageFilterVariables,
  SystemTagSlug,
  TagView,
} from "../api/schema-types";
import { parseSearchQuery, searchToFilterVariables } from "./search-query";

export type MailboxFolder =
  | { readonly kind: "INBOX" }
  | { readonly kind: "STARRED" }
  | { readonly kind: "SENT" }
  | { readonly kind: "DRAFTS" }
  | { readonly kind: "ARCHIVED" }
  | { readonly kind: "SPAM" }
  | { readonly kind: "TRASH" }
  | { readonly kind: "TAG"; readonly tagId: string; readonly name: string }
  | { readonly kind: "SEARCH"; readonly query: string };

export interface MailboxScope {
  readonly domainId?: string;
  readonly address?: string;
}

export interface MailboxView {
  readonly folder: MailboxFolder;
  readonly scope: MailboxScope;
}

const SLUG_VIEWS: Readonly<Record<string, SystemTagSlug>> = {
  STARRED: "STARRED",
  ARCHIVED: "ARCHIVED",
  TRASH: "TRASH",
};

function folderToFilter(
  folder: MailboxFolder,
  tags: readonly TagView[],
): MessageFilterVariables {
  switch (folder.kind) {
    case "INBOX":
      return { direction: "INBOUND" };
    case "SENT":
      return { direction: "OUTBOUND", statuses: ["SENT"] };
    case "DRAFTS":
      return { statuses: ["DRAFT"] };
    case "SPAM":
      return { spamOnly: true };
    case "STARRED":
    case "ARCHIVED":
    case "TRASH": {
      const slug = SLUG_VIEWS[folder.kind];
      return slug === undefined ? {} : { systemSlugs: [slug] };
    }
    case "TAG":
      return { tagIds: [folder.tagId] };
    case "SEARCH": {
      const variables = searchToFilterVariables(
        parseSearchQuery(folder.query),
        tags,
      );
      return { includeSpam: true, ...variables };
    }
  }
}

/** Combines the selected folder's filter with its domain or mailbox scope. */
export function viewToFilter(
  view: MailboxView,
  tags: readonly TagView[] = [],
): MessageFilterVariables {
  const filter = folderToFilter(view.folder, tags);
  const addressFilter: MessageFilterVariables =
    view.scope.address === undefined
      ? {}
      : view.folder.kind === "INBOX"
        ? { toAddress: view.scope.address }
        : view.folder.kind === "SENT" || view.folder.kind === "DRAFTS"
          ? { fromAddress: view.scope.address }
          : { address: view.scope.address };
  return {
    ...filter,
    ...(view.scope.domainId === undefined
      ? {}
      : { domainId: view.scope.domainId }),
    ...addressFilter,
  };
}

/** Serializes folder and scope so a mailbox is linkable. */
export function fullSearchParamsForView(
  view: MailboxView,
): Record<string, string | undefined> {
  const params = viewToSearchParams(view);
  return {
    view: params.get("view") ?? undefined,
    domain: params.get("domain") ?? undefined,
    address: params.get("address") ?? undefined,
    tag: params.get("tag") ?? undefined,
    name: params.get("name") ?? undefined,
    q: params.get("q") ?? undefined,
  };
}

export function viewToSearchParams(view: MailboxView): URLSearchParams {
  const params = new URLSearchParams();
  params.set("view", view.folder.kind);
  if (view.scope.domainId !== undefined) {
    params.set("domain", view.scope.domainId);
  }
  if (view.scope.address !== undefined) {
    params.set("address", view.scope.address);
  }
  if (view.folder.kind === "TAG") {
    params.set("tag", view.folder.tagId);
    params.set("name", view.folder.name);
  }
  if (view.folder.kind === "SEARCH") {
    params.set("q", view.folder.query);
  }
  return params;
}

function parseFolder(params: URLSearchParams): MailboxFolder {
  switch (params.get("view")) {
    case "SENT":
      return { kind: "SENT" };
    case "DRAFTS":
      return { kind: "DRAFTS" };
    case "SPAM":
      return { kind: "SPAM" };
    case "STARRED":
      return { kind: "STARRED" };
    case "ARCHIVED":
      return { kind: "ARCHIVED" };
    case "TRASH":
      return { kind: "TRASH" };
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

/** Parses folder and scope params, including legacy ADDRESS URLs. */
export function searchParamsToView(params: URLSearchParams): MailboxView {
  const rawLegacyAddress =
    params.get("view") === "ADDRESS" ? params.get("address") : null;
  const legacyAddress = rawLegacyAddress === "" ? null : rawLegacyAddress;
  const rawDomainId = params.get("domain");
  const rawAddress = params.get("address");
  const domainId = rawDomainId === "" ? null : rawDomainId;
  const address = rawAddress === "" ? null : rawAddress;
  const folder = parseFolder(params);
  return {
    folder,
    scope: {
      ...(domainId === null ? {} : { domainId }),
      ...(legacyAddress !== null
        ? { address: legacyAddress }
        : address === null
          ? {}
          : { address }),
    },
  };
}

function folderTitle(folder: MailboxFolder): string {
  switch (folder.kind) {
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
    case "TAG":
      return folder.name;
    case "SEARCH":
      return `Search: ${folder.query}`;
  }
}

export function viewTitle(
  view: MailboxView,
  domains: readonly MailDomainView[] = [],
): string {
  const base = folderTitle(view.folder);
  const scopeLabel =
    view.scope.address ??
    domains.find((domain) => domain.id === view.scope.domainId)?.name;
  return scopeLabel === undefined ? base : `${base} - ${scopeLabel}`;
}
