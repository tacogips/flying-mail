import { BadUserInputError } from "@flying-mail/application/errors";
import { describe, expect, test } from "vitest";
import {
  parseArguments,
  toJsonSchema,
  type FieldSpecMap,
  type InferArgs,
} from "./tool-schema";

const spec = {
  id: {
    kind: "string",
    description: "Identifier",
    required: true,
    maxLength: 128,
    format: "id",
  },
  mode: {
    kind: "string",
    description: "Mode",
    enum: ["FAST", "SAFE"],
    maxLength: 8,
  },
  page: {
    kind: "integer",
    description: "Page",
    minimum: 1,
    maximum: 10,
    default: 2,
  },
  enabled: { kind: "boolean", description: "Enabled", default: true },
  tags: {
    kind: "string_array",
    description: "Tags",
    maxItems: 4,
    itemMaxLength: 20,
  },
  at: {
    kind: "string",
    description: "Date and time",
    maxLength: 40,
    format: "date-time",
  },
} as const satisfies FieldSpecMap;

describe("MCP FieldSpec schemas and parser", () => {
  test("derives object schema, required fields, formats, bounds, enums and defaults", () => {
    expect(toJsonSchema(spec)).toEqual({
      type: "object",
      properties: {
        id: {
          description: "Identifier",
          type: "string",
          maxLength: 128,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
        },
        mode: {
          description: "Mode",
          type: "string",
          maxLength: 8,
          enum: ["FAST", "SAFE"],
        },
        page: {
          description: "Page",
          type: "integer",
          minimum: 1,
          maximum: 10,
          default: 2,
        },
        enabled: { description: "Enabled", type: "boolean", default: true },
        tags: {
          description: "Tags",
          type: "array",
          maxItems: 4,
          items: { type: "string", maxLength: 20 },
        },
        at: {
          description: "Date and time",
          type: "string",
          maxLength: 40,
          format: "date-time",
        },
      },
      required: ["id"],
      additionalProperties: false,
    });
    expect(toJsonSchema(spec).required).not.toContain("page");
  });

  test("validates required, unknown, range, integer, format and defaults", () => {
    expect(() => parseArguments(spec, {})).toThrow(
      expect.objectContaining({ field: "id" }),
    );
    expect(() => parseArguments(spec, { id: "ok", extra: true })).toThrow(
      expect.objectContaining({ field: "extra" }),
    );
    expect(() => parseArguments(spec, { id: "ok", page: 11 })).toThrow(
      BadUserInputError,
    );
    expect(() => parseArguments(spec, { id: "ok", page: 1.5 })).toThrow(
      BadUserInputError,
    );
    expect(() => parseArguments(spec, { id: "bad id", page: 1 })).toThrow(
      BadUserInputError,
    );
    expect(() =>
      parseArguments(spec, { id: "ok", page: 1, at: "December 2025" }),
    ).toThrow(BadUserInputError);
    expect(parseArguments(spec, { id: "ok" })).toMatchObject({
      page: 2,
      enabled: true,
    });
  });

  test("infers enum literals", () => {
    type Args = InferArgs<typeof spec>;
    const valid: Args["mode"] = "FAST";
    expect(valid).toBe("FAST");
  });
});
