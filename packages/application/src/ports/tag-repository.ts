import type { SystemTagSlug, Tag } from "@mailcal/domain/entities/tag";
import type { TagId } from "@mailcal/domain/value-objects/ids";

export interface TagRepository {
  findById(id: TagId): Promise<Tag | null>;
  findByIds(ids: readonly TagId[]): Promise<readonly Tag[]>;
  findByName(name: string): Promise<Tag | null>;
  /** System tags are always addressed by slug, never by display name, so a
   * renamed label cannot break classification. */
  findBySystemSlug(slug: SystemTagSlug): Promise<Tag | null>;
  list(): Promise<readonly Tag[]>;
  countMessages(ids: readonly TagId[]): Promise<ReadonlyMap<string, number>>;
  save(tag: Tag): Promise<void>;
  delete(id: TagId): Promise<void>;
}
