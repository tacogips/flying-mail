import { describe, expect, test } from "vitest";
import { ValidationError } from "../errors";
import { createEmailAddress } from "../value-objects/email-address";
import { createClassificationRuleId, createTagId } from "../value-objects/ids";
import {
  type ClassificationRule,
  createClassificationRule,
  RuleAction,
  RuleField,
  RuleMatcher,
  ruleMatches,
  setRuleEnabled,
} from "./classification-rule";

const NOW = "2026-08-23T00:00:00.000Z";

function rule(
  overrides: Partial<Parameters<typeof createClassificationRule>[0]>,
): ClassificationRule {
  return createClassificationRule({
    id: createClassificationRuleId("rule-1"),
    domainId: null,
    field: RuleField.SenderAddress,
    matcher: RuleMatcher.Exact,
    pattern: "noreply@shop.example",
    action: RuleAction.Spam,
    tagId: null,
    description: null,
    createdAt: NOW,
    ...overrides,
  });
}

const INPUT = {
  senderAddress: createEmailAddress("noreply@shop.example"),
  subject: "Big sale",
  listId: null,
};

describe("createClassificationRule", () => {
  test("a TAG rule requires a tagId, others refuse one", () => {
    expect(() => rule({ action: RuleAction.Tag })).toThrow(ValidationError);
    expect(() =>
      rule({ action: RuleAction.Spam, tagId: createTagId("t1") }),
    ).toThrow(ValidationError);
    expect(
      rule({ action: RuleAction.Tag, tagId: createTagId("t1") }).tagId,
    ).toBe("t1");
  });

  test("rejects an invalid regular expression at creation time", () => {
    expect(() =>
      rule({ matcher: RuleMatcher.Regex, pattern: "([unclosed" }),
    ).toThrow(ValidationError);
  });

  test("rejects an empty or oversized pattern", () => {
    expect(() => rule({ pattern: "   " })).toThrow(ValidationError);
    expect(() => rule({ pattern: "x".repeat(513) })).toThrow(ValidationError);
  });
});

describe("ruleMatches", () => {
  test("exact matching is case-insensitive", () => {
    expect(ruleMatches(rule({ pattern: "NOREPLY@SHOP.EXAMPLE" }), INPUT)).toBe(
      true,
    );
    expect(ruleMatches(rule({ pattern: "other@shop.example" }), INPUT)).toBe(
      false,
    );
  });

  test("sender domain matches the part after the @", () => {
    const byDomain = rule({
      field: RuleField.SenderDomain,
      pattern: "shop.example",
    });
    expect(ruleMatches(byDomain, INPUT)).toBe(true);
  });

  test("contains and regex matchers work on the subject", () => {
    expect(
      ruleMatches(
        rule({
          field: RuleField.Subject,
          matcher: RuleMatcher.Contains,
          pattern: "sale",
        }),
        INPUT,
      ),
    ).toBe(true);
    expect(
      ruleMatches(
        rule({
          field: RuleField.Subject,
          matcher: RuleMatcher.Regex,
          pattern: "^big\\s+sale$",
        }),
        INPUT,
      ),
    ).toBe(true);
  });

  test("a LIST_ID rule never matches a message without a list id", () => {
    const byList = rule({
      field: RuleField.ListId,
      matcher: RuleMatcher.Contains,
      pattern: "dev",
    });
    expect(ruleMatches(byList, INPUT)).toBe(false);
    expect(
      ruleMatches(byList, { ...INPUT, listId: "dev.mailcal.example" }),
    ).toBe(true);
  });

  test("a disabled rule matches nothing", () => {
    const disabled = setRuleEnabled(rule({}), false, NOW);
    expect(ruleMatches(disabled, INPUT)).toBe(false);
  });

  test("a stored pattern that no longer compiles fails closed", () => {
    // Bypass the factory guard to simulate a legacy or hand-edited row.
    const broken = { ...rule({}), matcher: RuleMatcher.Regex, pattern: "([" };
    expect(ruleMatches(broken, INPUT)).toBe(false);
  });
});
