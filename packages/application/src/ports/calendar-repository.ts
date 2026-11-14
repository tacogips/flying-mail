import type { Calendar } from "@mailcal/domain/entities/calendar";
import type { CalendarId, UserId } from "@mailcal/domain/value-objects/ids";

export interface CalendarRepository {
  findById(id: CalendarId): Promise<Calendar | null>;
  findByIds(ids: readonly CalendarId[]): Promise<readonly Calendar[]>;
  listByOwner(ownerUserId: UserId): Promise<readonly Calendar[]>;
  /** Every calendar on the instance. Only reachable behind an ADMIN check or
   * an API-key scope filter -- the use case, not the repository, decides. */
  listAll(): Promise<readonly Calendar[]>;
  save(calendar: Calendar): Promise<void>;
  /** Hard delete; events cascade. */
  delete(id: CalendarId): Promise<void>;
}
