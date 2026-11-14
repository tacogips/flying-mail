import type { MailDomain } from "@mailcal/domain/entities/mail-domain";
import type { DomainName } from "@mailcal/domain/value-objects/domain-name";
import type { DomainId } from "@mailcal/domain/value-objects/ids";

export interface MailDomainRepository {
  findById(id: DomainId): Promise<MailDomain | null>;
  findByName(name: DomainName): Promise<MailDomain | null>;
  list(): Promise<readonly MailDomain[]>;
  /** Upsert by id. */
  save(domain: MailDomain): Promise<void>;
  delete(id: DomainId): Promise<void>;
  /** Used to refuse deleting a domain that still holds mail, so a config
   * change can never orphan stored messages. */
  countMessages(id: DomainId): Promise<number>;
  /** True when any message has ever been delivered to this exact address.
   * Backs the non-catch-all accept decision on the ingest path. */
  hasKnownLocalPart(id: DomainId, address: string): Promise<boolean>;
}
