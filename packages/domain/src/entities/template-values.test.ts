import { describe, expect, it } from "vitest";
import { type TemplateVariable, TemplateVariableType } from "./mail-template";
import {
  buildTemplateRenderData,
  coerceTemplateValue,
  describeTemplateValidation,
  validateTemplateValues,
} from "./template-values";

function variable(
  overrides: Partial<TemplateVariable> & { readonly key: string },
): TemplateVariable {
  return {
    label: overrides.key,
    type: TemplateVariableType.Text,
    required: true,
    defaultValue: null,
    description: null,
    ...overrides,
  };
}

describe("coerceTemplateValue", () => {
  it("keeps text verbatim, including surrounding whitespace", () => {
    expect(coerceTemplateValue(TemplateVariableType.Text, "  hi  ")).toEqual({
      ok: true,
      value: "  hi  ",
    });
  });

  it("parses a finite number and rejects anything else", () => {
    expect(coerceTemplateValue(TemplateVariableType.Number, " 12.5 ")).toEqual({
      ok: true,
      value: 12.5,
    });
    expect(coerceTemplateValue(TemplateVariableType.Number, "abc").ok).toBe(
      false,
    );
    expect(
      coerceTemplateValue(TemplateVariableType.Number, "Infinity").ok,
    ).toBe(false);
    expect(coerceTemplateValue(TemplateVariableType.Number, "").ok).toBe(false);
  });

  it("accepts the documented boolean spellings", () => {
    for (const raw of ["true", "TRUE", "1", "yes", "on"]) {
      expect(coerceTemplateValue(TemplateVariableType.Boolean, raw)).toEqual({
        ok: true,
        value: true,
      });
    }
    for (const raw of ["false", "0", "No", "off"]) {
      expect(coerceTemplateValue(TemplateVariableType.Boolean, raw)).toEqual({
        ok: true,
        value: false,
      });
    }
    expect(coerceTemplateValue(TemplateVariableType.Boolean, "maybe").ok).toBe(
      false,
    );
  });

  it("keeps a date-only value as written and normalizes a timestamp", () => {
    expect(
      coerceTemplateValue(TemplateVariableType.Date, "2026-08-24"),
    ).toEqual({ ok: true, value: "2026-08-24" });
    expect(
      coerceTemplateValue(TemplateVariableType.Date, "2026-08-24T05:00:00Z"),
    ).toEqual({ ok: true, value: "2026-08-24T05:00:00.000Z" });
  });

  it("rejects a calendar date that does not exist", () => {
    expect(
      coerceTemplateValue(TemplateVariableType.Date, "2026-02-31"),
    ).toEqual({ ok: false, reason: "must be a real calendar date" });
  });

  it("normalizes an email and rejects a malformed one", () => {
    expect(
      coerceTemplateValue(TemplateVariableType.Email, " Person@Example.COM "),
    ).toEqual({ ok: true, value: "person@example.com" });
    expect(coerceTemplateValue(TemplateVariableType.Email, "nope").ok).toBe(
      false,
    );
  });
});

describe("validateTemplateValues", () => {
  const variables = [
    variable({ key: "name" }),
    variable({ key: "count", type: TemplateVariableType.Number }),
    variable({ key: "note", required: false }),
  ];

  it("passes when every required variable is supplied", () => {
    const result = validateTemplateValues(variables, [
      { key: "name", value: "Ada" },
      { key: "count", value: "3" },
    ]);
    expect(result).toEqual({
      valid: true,
      missing: [],
      invalid: [],
      unknown: [],
    });
  });

  it("reports each unsupplied required variable", () => {
    const result = validateTemplateValues(variables, []);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(["name", "count"]);
  });

  it("treats a whitespace-only value as unsupplied", () => {
    const result = validateTemplateValues(variables, [
      { key: "name", value: "   " },
      { key: "count", value: "1" },
    ]);
    expect(result.missing).toEqual(["name"]);
  });

  it("does not report a required variable that has a default", () => {
    const withDefault = [variable({ key: "name", defaultValue: "there" })];
    expect(validateTemplateValues(withDefault, []).valid).toBe(true);
  });

  it("reports a value that fails its type", () => {
    const result = validateTemplateValues(variables, [
      { key: "name", value: "Ada" },
      { key: "count", value: "many" },
    ]);
    expect(result.valid).toBe(false);
    expect(result.invalid).toEqual([
      { key: "count", reason: "must be a finite number" },
    ]);
  });

  it("reports a default that cannot be coerced under its own type", () => {
    const bad = [
      variable({
        key: "count",
        type: TemplateVariableType.Number,
        required: false,
        defaultValue: "many",
      }),
    ];
    expect(validateTemplateValues(bad, []).invalid).toEqual([
      { key: "count", reason: "default value must be a finite number" },
    ]);
  });

  it("lists an undeclared key without failing validation", () => {
    const result = validateTemplateValues(variables, [
      { key: "name", value: "Ada" },
      { key: "count", value: "3" },
      { key: "stray", value: "x" },
    ]);
    expect(result.valid).toBe(true);
    expect(result.unknown).toEqual(["stray"]);
  });

  it("keeps the last entry when a key is supplied twice", () => {
    const result = validateTemplateValues(
      [variable({ key: "name" })],
      [
        { key: "name", value: "" },
        { key: "name", value: "Ada" },
      ],
    );
    expect(result.valid).toBe(true);
  });
});

describe("buildTemplateRenderData", () => {
  it("includes only declared variables, so an undeclared key cannot inject", () => {
    const data = buildTemplateRenderData(
      [variable({ key: "name" })],
      [
        { key: "name", value: "Ada" },
        { key: "stray", value: "injected" },
      ],
    );
    expect(data).toEqual({ name: "Ada" });
  });

  it("falls back to the default, then to an empty string", () => {
    const data = buildTemplateRenderData(
      [
        variable({ key: "greeting", required: false, defaultValue: "Hello" }),
        variable({ key: "note", required: false }),
      ],
      [],
    );
    expect(data).toEqual({ greeting: "Hello", note: "" });
  });

  it("coerces to the declared type rather than leaving strings", () => {
    const data = buildTemplateRenderData(
      [
        variable({ key: "count", type: TemplateVariableType.Number }),
        variable({ key: "flag", type: TemplateVariableType.Boolean }),
      ],
      [
        { key: "count", value: "7" },
        { key: "flag", value: "yes" },
      ],
    );
    expect(data).toEqual({ count: 7, flag: true });
  });
});

describe("describeTemplateValidation", () => {
  it("names both missing and invalid keys", () => {
    const message = describeTemplateValidation({
      valid: false,
      missing: ["name"],
      invalid: [{ key: "count", reason: "must be a finite number" }],
      unknown: [],
    });
    expect(message).toContain("missing values for name");
    expect(message).toContain("count must be a finite number");
  });
});
