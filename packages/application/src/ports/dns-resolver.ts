/** Read-only DNS lookups, used by domain verification. */
export interface MxRecord {
  readonly priority: number;
  readonly exchange: string;
}

export interface DnsResolver {
  /** TXT record values for `name`, quotes stripped, empty when none. Must
   * reject (not return empty) on a transport failure, so "no record" and
   * "lookup broken" stay distinguishable to the caller. */
  lookupTxt(name: string): Promise<readonly string[]>;

  /** MX records for `name`; exchanges are lowercase and have no trailing
   * dot. Transport failures reject, matching {@link lookupTxt}. */
  lookupMx(name: string): Promise<readonly MxRecord[]>;
}
