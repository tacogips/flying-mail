/** Read-only DNS lookups, used by domain verification. */
export interface DnsResolver {
  /** TXT record values for `name`, quotes stripped, empty when none. Must
   * reject (not return empty) on a transport failure, so "no record" and
   * "lookup broken" stay distinguishable to the caller. */
  lookupTxt(name: string): Promise<readonly string[]>;
}
