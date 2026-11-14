import { SystemTagImmutableError, ValidationError } from "../errors";
import type { TagId } from "../value-objects/ids";

export enum TagKind {
  User = "USER",
  System = "SYSTEM",
}

/** Reserved tags addressed by slug rather than by display name, so a
 * renamed label can never break classification or client behavior. */
/** `SPAM` is deliberately absent: spam is a verdict with metadata and
 * lives in its own `message_spam` table (see `spam-mark.ts`), not in the
 * tag namespace. */
export enum SystemTagSlug {
  Trash = "TRASH",
  Archived = "ARCHIVED",
  Starred = "STARRED",
}

export interface Tag {
  readonly id: TagId;
  readonly name: string;
  readonly color: string | null;
  readonly kind: TagKind;
  readonly systemSlug: SystemTagSlug | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateUserTagInput {
  readonly id: TagId;
  readonly name: string;
  readonly color: string | null;
  readonly createdAt: string;
}

export interface CreateSystemTagInput {
  readonly id: TagId;
  readonly slug: SystemTagSlug;
  readonly name: string;
  readonly color: string | null;
  readonly createdAt: string;
}

const MAX_TAG_NAME_LENGTH = 64;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/;

const SYSTEM_SLUG_VALUES: ReadonlySet<string> = new Set(
  Object.values(SystemTagSlug),
);

function normalizeName(name: string, field = "name"): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("tag name must not be empty", field);
  }
  if (trimmed.length > MAX_TAG_NAME_LENGTH) {
    throw new ValidationError(
      `tag name must be at most ${MAX_TAG_NAME_LENGTH} characters`,
      field,
    );
  }
  return trimmed;
}

function normalizeColor(color: string | null): string | null {
  if (color === null) {
    return null;
  }
  const normalized = color.trim().toLowerCase();
  if (!COLOR_PATTERN.test(normalized)) {
    throw new ValidationError("tag color must be a #rrggbb hex value", "color");
  }
  return normalized;
}

function assertNotSystemName(name: string): void {
  if (SYSTEM_SLUG_VALUES.has(name.toUpperCase())) {
    throw new ValidationError(`"${name}" is reserved for a system tag`, "name");
  }
}

export function createUserTag(input: CreateUserTagInput): Tag {
  const name = normalizeName(input.name);
  assertNotSystemName(name);
  return {
    id: input.id,
    name,
    color: normalizeColor(input.color),
    kind: TagKind.User,
    systemSlug: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function createSystemTag(input: CreateSystemTagInput): Tag {
  return {
    id: input.id,
    name: normalizeName(input.name),
    color: normalizeColor(input.color),
    kind: TagKind.System,
    systemSlug: input.slug,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function assertMutable(tag: Tag, action: string): void {
  if (tag.kind === TagKind.System) {
    throw new SystemTagImmutableError(
      `System tag "${tag.name}" cannot be ${action}`,
      tag.id,
    );
  }
}

export function renameTag(
  tag: Tag,
  name: string,
  color: string | null,
  updatedAt: string,
): Tag {
  assertMutable(tag, "renamed");
  const normalized = normalizeName(name);
  assertNotSystemName(normalized);
  return {
    ...tag,
    name: normalized,
    color: normalizeColor(color),
    updatedAt,
  };
}

export function assertTagDeletable(tag: Tag): void {
  assertMutable(tag, "deleted");
}

/** Display defaults for the tags seeded by the initial migration, so the
 * seed SQL and any programmatic seeding agree on one source of truth. */
export const SYSTEM_TAG_DEFAULTS: ReadonlyMap<
  SystemTagSlug,
  { readonly name: string; readonly color: string }
> = new Map([
  [SystemTagSlug.Trash, { name: "Trash", color: "#6b7280" }],
  [SystemTagSlug.Archived, { name: "Archived", color: "#0f766e" }],
  [SystemTagSlug.Starred, { name: "Starred", color: "#b45309" }],
]);
