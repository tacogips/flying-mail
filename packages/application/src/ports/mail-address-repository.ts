import type { MailAddress } from "@mailcal/domain/entities/mail-address";
import type {
  DomainId,
  MailAddressId,
} from "@mailcal/domain/value-objects/ids";

/** Persistence boundary for explicitly provisioned mailboxes. */
export interface MailAddressRepository {
  findById(id: MailAddressId): Promise<MailAddress | null>;
  /** Exact match on the full address. The ingest hot path -- one indexed
   * lookup, no local-part parsing in SQL. */
  findByAddress(address: string): Promise<MailAddress | null>;
  listByDomain(domainId: DomainId): Promise<readonly MailAddress[]>;
  list(): Promise<readonly MailAddress[]>;
  save(address: MailAddress): Promise<void>;
  delete(id: MailAddressId): Promise<void>;
  /** Messages already stored for this address, so a delete can refuse to
   * orphan mail the way `deleteDomain` already does. */
  countMessages(id: MailAddressId): Promise<number>;
}
