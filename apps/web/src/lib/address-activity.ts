export interface AddressActivityView {
  readonly address: string;
  readonly domainId: string;
  readonly lastActivityAt: string | null;
  readonly unreadCount: number;
}

export function sortAddressActivity(
  rows: readonly AddressActivityView[],
): readonly AddressActivityView[] {
  return [...rows].sort((left, right) => {
    if (left.lastActivityAt === null && right.lastActivityAt !== null) {
      return 1;
    }
    if (left.lastActivityAt !== null && right.lastActivityAt === null) {
      return -1;
    }
    if (left.lastActivityAt !== right.lastActivityAt) {
      return (right.lastActivityAt ?? "").localeCompare(
        left.lastActivityAt ?? "",
      );
    }
    return left.address.localeCompare(right.address);
  });
}

export function visibleAddressActivity(
  rows: readonly AddressActivityView[],
  options: {
    readonly domainId?: string;
    readonly selectedAddress?: string;
    readonly filter: string;
    readonly expanded: boolean;
    readonly limit?: number;
  },
): readonly AddressActivityView[] {
  const limit = options.limit ?? 7;
  const scoped = sortAddressActivity(
    rows.filter(
      (row) =>
        options.domainId === undefined || row.domainId === options.domainId,
    ),
  );
  const query = options.filter.trim().toLocaleLowerCase();
  const filtered =
    query.length === 0
      ? scoped
      : scoped.filter((row) => row.address.toLocaleLowerCase().includes(query));
  const visible =
    options.expanded || filtered.length <= limit
      ? filtered
      : filtered.slice(0, limit);
  const selected = scoped.find(
    (row) => row.address === options.selectedAddress,
  );
  if (
    selected !== undefined &&
    !visible.some((row) => row.address === selected.address)
  ) {
    return [...visible, selected];
  }
  return visible;
}

export const ADDRESS_LIST_EXPANDED_KEY = "flying-mail.address-list-expanded";

export type AddressListStorage = Pick<Storage, "getItem" | "setItem">;

export function readAddressListExpanded(
  storage: AddressListStorage | undefined,
): boolean {
  try {
    return storage?.getItem(ADDRESS_LIST_EXPANDED_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeAddressListExpanded(
  storage: AddressListStorage | undefined,
  expanded: boolean,
): void {
  try {
    storage?.setItem(ADDRESS_LIST_EXPANDED_KEY, String(expanded));
  } catch {
    // Storage can be disabled or unavailable in private browsing contexts.
  }
}
