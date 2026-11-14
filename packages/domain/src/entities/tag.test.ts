import { describe, expect, test } from "vitest";
import { SystemTagImmutableError, ValidationError } from "../errors";
import { createTagId } from "../value-objects/ids";
import {
  assertTagDeletable,
  createSystemTag,
  createUserTag,
  renameTag,
  SYSTEM_TAG_DEFAULTS,
  SystemTagSlug,
  TagKind,
} from "./tag";

const userTag = () =>
  createUserTag({
    id: createTagId("tag-1"),
    name: "  Invoices  ",
    color: "#AABBCC",
    createdAt: "2026-08-23T00:00:00.000Z",
  });

const spamTag = () =>
  createSystemTag({
    id: createTagId("tag-spam"),
    slug: SystemTagSlug.Trash,
    name: "Trash",
    color: "#b91c1c",
    createdAt: "2026-08-23T00:00:00.000Z",
  });

describe("createUserTag", () => {
  test("trims the name and normalizes the color", () => {
    const tag = userTag();
    expect(tag.name).toBe("Invoices");
    expect(tag.color).toBe("#aabbcc");
    expect(tag.kind).toBe(TagKind.User);
    expect(tag.systemSlug).toBeNull();
  });

  test("allows a null color", () => {
    const tag = createUserTag({
      id: createTagId("tag-2"),
      name: "Later",
      color: null,
      createdAt: "2026-08-23T00:00:00.000Z",
    });
    expect(tag.color).toBeNull();
  });

  test.each([
    ["", "blank"],
    ["   ", "whitespace"],
  ])("rejects a %s name (%s)", (name) => {
    expect(() =>
      createUserTag({
        id: createTagId("tag-3"),
        name,
        color: null,
        createdAt: "2026-08-23T00:00:00.000Z",
      }),
    ).toThrow(ValidationError);
  });

  test("rejects an over-long name", () => {
    expect(() =>
      createUserTag({
        id: createTagId("tag-4"),
        name: "a".repeat(65),
        color: null,
        createdAt: "2026-08-23T00:00:00.000Z",
      }),
    ).toThrow(ValidationError);
  });

  test.each(["Trash", "TRASH", "ARCHIVED", "starred"])(
    "rejects the reserved system name %j",
    (name) => {
      expect(() =>
        createUserTag({
          id: createTagId("tag-5"),
          name,
          color: null,
          createdAt: "2026-08-23T00:00:00.000Z",
        }),
      ).toThrow(ValidationError);
    },
  );

  test.each(["red", "#abc", "#GGHHII", "aabbcc", "#aabbccdd"])(
    "rejects the invalid color %j",
    (color) => {
      expect(() =>
        createUserTag({
          id: createTagId("tag-6"),
          name: "Colorful",
          color,
          createdAt: "2026-08-23T00:00:00.000Z",
        }),
      ).toThrow(ValidationError);
    },
  );
});

describe("system tags", () => {
  test("carry their slug and kind", () => {
    const tag = spamTag();
    expect(tag.kind).toBe(TagKind.System);
    expect(tag.systemSlug).toBe(SystemTagSlug.Trash);
  });

  test("cannot be renamed", () => {
    expect(() =>
      renameTag(spamTag(), "Junk", null, "2026-08-23T01:00:00.000Z"),
    ).toThrow(SystemTagImmutableError);
  });

  test("cannot be deleted", () => {
    expect(() => assertTagDeletable(spamTag())).toThrow(
      SystemTagImmutableError,
    );
  });

  test("defaults are defined for every slug", () => {
    for (const slug of Object.values(SystemTagSlug)) {
      expect(SYSTEM_TAG_DEFAULTS.get(slug)).toBeDefined();
    }
  });
});

describe("renameTag", () => {
  test("renames and recolors a user tag", () => {
    const renamed = renameTag(
      userTag(),
      "  Receipts ",
      "#112233",
      "2026-08-23T01:00:00.000Z",
    );
    expect(renamed.name).toBe("Receipts");
    expect(renamed.color).toBe("#112233");
    expect(renamed.updatedAt).toBe("2026-08-23T01:00:00.000Z");
  });

  test("refuses to rename a user tag onto a reserved system name", () => {
    expect(() =>
      renameTag(userTag(), "Trash", null, "2026-08-23T01:00:00.000Z"),
    ).toThrow(ValidationError);
  });

  test("a user tag is deletable", () => {
    expect(() => assertTagDeletable(userTag())).not.toThrow();
  });
});
