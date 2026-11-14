import type { MailTemplate } from "@mailcal/domain/entities/mail-template";
import type { MailTemplateId } from "@mailcal/domain/value-objects/ids";

/** Persistence boundary for the instance-wide mail-template catalogue.
 *
 * A template and its variable set are always written and read as one unit:
 * a body that references `it.x` and a variable set that has just lost `x`
 * must never be observable together. */
export interface MailTemplateRepository {
  findById(id: MailTemplateId): Promise<MailTemplate | null>;
  /** Case-insensitive, matching the duplicate-name rule the use cases
   * enforce -- "Invoice" and "invoice" are the same template to a reader. */
  findByName(name: string): Promise<MailTemplate | null>;
  list(): Promise<readonly MailTemplate[]>;
  /** Inserts or replaces the template *and* its whole variable set. */
  save(template: MailTemplate): Promise<void>;
  delete(id: MailTemplateId): Promise<void>;
}
