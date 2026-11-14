import { describe, expect, test } from "vitest";
import type {
  MailTemplateView,
  TemplateVariableView,
} from "../api/schema-types";
import {
  blankToNull,
  describeTemplateGate,
  initialTemplateValues,
  splitAddressField,
  toTemplateValueList,
  unusedVariableKeys,
} from "./template-form";

function variable(
  key: string,
  overrides: Partial<TemplateVariableView> = {},
): TemplateVariableView {
  return {
    key,
    label: key,
    type: "TEXT",
    required: true,
    defaultValue: null,
    description: null,
    ...overrides,
  };
}

describe("splitAddressField", () => {
  test("splits on commas, semicolons and newlines and trims", () => {
    expect(splitAddressField(" a@x.com , b@x.com;c@x.com\nd@x.com ")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
    ]);
  });

  test("drops empty entries and returns nothing for a blank field", () => {
    expect(splitAddressField("a@x.com,,  ,;")).toEqual(["a@x.com"]);
    expect(splitAddressField("   ")).toEqual([]);
  });
});

describe("initialTemplateValues", () => {
  test("pre-fills defaults and blanks the rest", () => {
    expect(
      initialTemplateValues({
        variables: [
          variable("greeting", { defaultValue: "Hello" }),
          variable("name"),
        ],
      }),
    ).toEqual({ greeting: "Hello", name: "" });
  });

  test("is empty for a template with no variables", () => {
    expect(initialTemplateValues({ variables: [] })).toEqual({});
  });
});

describe("toTemplateValueList", () => {
  test("maps the record into the wire shape", () => {
    expect(toTemplateValueList({ a: "1", b: "" })).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "" },
    ]);
  });
});

describe("describeTemplateGate", () => {
  test("is null before any validation has run and once it passes", () => {
    expect(describeTemplateGate(null)).toBeNull();
    expect(
      describeTemplateGate({
        valid: true,
        missing: [],
        invalid: [],
        unknown: [],
      }),
    ).toBeNull();
  });

  test("names the missing variables", () => {
    expect(
      describeTemplateGate({
        valid: false,
        missing: ["name", "amount"],
        invalid: [],
        unknown: [],
      }),
    ).toBe("Still needed: name, amount");
  });

  test("falls back to the invalid reasons when nothing is missing", () => {
    expect(
      describeTemplateGate({
        valid: false,
        missing: [],
        invalid: [{ key: "amount", reason: "must be a finite number" }],
        unknown: [],
      }),
    ).toBe("amount must be a finite number");
  });

  test("an unknown key alone does not close the gate", () => {
    expect(
      describeTemplateGate({
        valid: true,
        missing: [],
        invalid: [],
        unknown: ["stray"],
      }),
    ).toBeNull();
  });
});

describe("unusedVariableKeys", () => {
  const template = (
    variables: readonly TemplateVariableView[],
    referenced: readonly string[],
  ): Pick<MailTemplateView, "variables" | "referencedVariableKeys"> => ({
    variables,
    referencedVariableKeys: referenced,
  });

  test("lists declared variables no source reads", () => {
    expect(
      unusedVariableKeys(
        template([variable("a"), variable("b"), variable("c")], ["a", "c"]),
      ),
    ).toEqual(["b"]);
  });

  test("is empty when every variable is read", () => {
    expect(unusedVariableKeys(template([variable("a")], ["a"]))).toEqual([]);
  });
});

describe("blankToNull", () => {
  test("maps a whitespace-only value to null and trims the rest", () => {
    expect(blankToNull("   ")).toBeNull();
    expect(blankToNull("")).toBeNull();
    expect(blankToNull("  hi  ")).toBe("hi");
  });
});
