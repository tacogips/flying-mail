export function matchesScope(
  domainFilter: string | null,
  addressFilter: string | null,
  row: { readonly domainId: string; readonly addresses: readonly string[] },
): boolean {
  if (domainFilter !== null && row.domainId !== domainFilter) return false;
  if (addressFilter !== null) {
    return row.addresses.some(
      (address) => address.trim().toLowerCase() === addressFilter,
    );
  }
  return true;
}

export function graphqlError(
  code: string,
  message: string,
): readonly unknown[] {
  return [{ message, extensions: { code } }];
}
