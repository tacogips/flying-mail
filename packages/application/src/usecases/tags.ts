import { Capability } from "@mailcal/domain/entities/api-key";
import {
  assertTagDeletable,
  createSystemTag,
  createUserTag,
  renameTag,
  SYSTEM_TAG_DEFAULTS,
  SystemTagSlug,
  type Tag,
} from "@mailcal/domain/entities/tag";
import { createTagId, type TagId } from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors";
import type { Viewer } from "../policies/viewer";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

/** Tags are instance-wide rather than per-domain, so mutating them needs
 * `MAIL_MANAGE` somewhere -- checked without an address, since there is no
 * single mailbox a tag belongs to. */
function requireTagManagement(viewer: Viewer): void {
  if (viewer.kind === "USER") {
    return;
  }
  const hasManage = viewer.scopes.some(
    (scope) => scope.capability === Capability.MailManage,
  );
  if (!hasManage) {
    throw new ForbiddenError("This credential is not permitted to manage tags");
  }
}

export function createListTagsUseCase(
  deps: AppDependencies,
): (viewer: Viewer) => Promise<readonly Tag[]> {
  return async () => deps.tagRepository.list();
}

export function createCreateTagUseCase(
  deps: AppDependencies,
): (viewer: Viewer, name: string, color: string | null) => Promise<Tag> {
  return async (viewer, name, color) =>
    withAsyncDomainErrorTranslation(async () => {
      requireTagManagement(viewer);
      const existing = await deps.tagRepository.findByName(name);
      if (existing !== null) {
        throw new ConflictError(`A tag named "${name}" already exists`);
      }
      const tag = createUserTag({
        id: createTagId(deps.random.uuid()),
        name,
        color,
        createdAt: deps.clock.now().toISOString(),
      });
      await deps.tagRepository.save(tag);
      return tag;
    });
}

export function createRenameTagUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: TagId,
  name: string,
  color: string | null,
) => Promise<Tag> {
  return async (viewer, id, name, color) =>
    withAsyncDomainErrorTranslation(async () => {
      requireTagManagement(viewer);
      const tag = await deps.tagRepository.findById(id);
      if (tag === null) {
        throw new NotFoundError("Tag", id);
      }
      const collision = await deps.tagRepository.findByName(name);
      if (collision !== null && collision.id !== id) {
        throw new ConflictError(`A tag named "${name}" already exists`);
      }
      const renamed = renameTag(
        tag,
        name,
        color,
        deps.clock.now().toISOString(),
      );
      await deps.tagRepository.save(renamed);
      return renamed;
    });
}

export function createDeleteTagUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: TagId) => Promise<boolean> {
  return async (viewer, id) =>
    withAsyncDomainErrorTranslation(async () => {
      requireTagManagement(viewer);
      const tag = await deps.tagRepository.findById(id);
      if (tag === null) {
        throw new NotFoundError("Tag", id);
      }
      assertTagDeletable(tag);
      await deps.tagRepository.delete(id);
      return true;
    });
}

/** Creates any missing system tag. Safe to call on every startup: existing
 * tags are left untouched, including a color an operator has customized. */
export function createEnsureSystemTagsUseCase(
  deps: AppDependencies,
): () => Promise<readonly Tag[]> {
  return async () => {
    const created: Tag[] = [];
    const now = deps.clock.now().toISOString();
    for (const [slug, defaults] of SYSTEM_TAG_DEFAULTS) {
      const existing = await deps.tagRepository.findBySystemSlug(slug);
      if (existing !== null) {
        created.push(existing);
        continue;
      }
      const tag = createSystemTag({
        id: createTagId(deps.random.uuid()),
        slug,
        name: defaults.name,
        color: defaults.color,
        createdAt: now,
      });
      await deps.tagRepository.save(tag);
      created.push(tag);
    }
    return created;
  };
}

export { SystemTagSlug };
