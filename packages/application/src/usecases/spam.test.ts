import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import { describe, expect, test } from "vitest";
import {
  isSpam,
  MAX_PHRASE_CONTRIBUTION,
  parseAuthenticationResults,
  scoreSpam,
  SPAM_WEIGHTS,
  type SpamSignalInput,
} from "./spam";

const sender = createEmailAddress("sender@example.com");

const baseInput: SpamSignalInput = {
  authenticationResults: null,
  envelopeFrom: sender,
  headerFrom: sender,
  subject: "Quarterly report",
  bodyText: "Please find the report attached.",
};

describe("parseAuthenticationResults", () => {
  test("a null header asserts nothing", () => {
    expect(parseAuthenticationResults(null)).toEqual({
      spfFailed: false,
      dkimFailed: false,
      dmarcFailed: false,
    });
  });

  test("detects each failure independently", () => {
    expect(parseAuthenticationResults("mx.example.com; spf=fail")).toEqual({
      spfFailed: true,
      dkimFailed: false,
      dmarcFailed: false,
    });
    expect(parseAuthenticationResults("dkim=fail header.d=x.com")).toEqual({
      spfFailed: false,
      dkimFailed: true,
      dmarcFailed: false,
    });
    expect(parseAuthenticationResults("dmarc=fail")).toEqual({
      spfFailed: false,
      dkimFailed: false,
      dmarcFailed: true,
    });
  });

  test("treats softfail as an SPF failure", () => {
    expect(parseAuthenticationResults("SPF=SoftFail").spfFailed).toBe(true);
  });

  test("passing results contribute nothing", () => {
    const verdict = parseAuthenticationResults(
      "mx.example.com; spf=pass; dkim=pass; dmarc=pass",
    );
    expect(verdict).toEqual({
      spfFailed: false,
      dkimFailed: false,
      dmarcFailed: false,
    });
  });

  test("an unparseable header contributes nothing", () => {
    expect(parseAuthenticationResults("gibberish ???")).toEqual({
      spfFailed: false,
      dkimFailed: false,
      dmarcFailed: false,
    });
  });
});

describe("scoreSpam", () => {
  test("a clean message scores zero with no reasons", () => {
    const result = scoreSpam(baseInput);
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  test("an auth failure contributes its weight once", () => {
    const result = scoreSpam({
      ...baseInput,
      authenticationResults: "spf=fail; dkim=fail",
    });
    expect(result.score).toBeCloseTo(SPAM_WEIGHTS.authFailure);
    expect(result.reasons).toContain("SPF and DKIM both failed");
  });

  test("DMARC adds on top of SPF/DKIM", () => {
    const result = scoreSpam({
      ...baseInput,
      authenticationResults: "spf=fail; dmarc=fail",
    });
    expect(result.score).toBeCloseTo(
      SPAM_WEIGHTS.authFailure + SPAM_WEIGHTS.dmarcFailure,
    );
  });

  test("an envelope/header From domain mismatch contributes", () => {
    const result = scoreSpam({
      ...baseInput,
      headerFrom: createEmailAddress("ceo@other.com"),
    });
    expect(result.score).toBeCloseTo(SPAM_WEIGHTS.fromMismatch);
    expect(result.reasons).toContain(
      "Envelope sender domain differs from the From header",
    );
  });

  test("a matching subject phrase contributes", () => {
    const result = scoreSpam({
      ...baseInput,
      subject: "You have WON a prize",
      phrases: ["won a prize"],
    });
    expect(result.score).toBeCloseTo(SPAM_WEIGHTS.phrase);
  });

  test("phrase contribution is capped", () => {
    const result = scoreSpam({
      ...baseInput,
      bodyText: "one two three four five six",
      phrases: ["one", "two", "three", "four", "five", "six"],
    });
    expect(result.score).toBeCloseTo(MAX_PHRASE_CONTRIBUTION);
  });

  test("blank phrases are ignored", () => {
    const result = scoreSpam({ ...baseInput, phrases: ["", "   "] });
    expect(result.score).toBe(0);
  });

  test("a blocked address short-circuits to 1", () => {
    const result = scoreSpam({
      ...baseInput,
      authenticationResults: "spf=pass",
      blockedAddresses: new Set([sender]),
    });
    expect(result.score).toBe(1);
    expect(result.reasons).toEqual(["Sender address is on the blocklist"]);
  });

  test("a blocked domain short-circuits to 1", () => {
    const result = scoreSpam({
      ...baseInput,
      blockedDomains: new Set(["example.com"]),
    });
    expect(result.score).toBe(1);
  });

  test("the total is clamped to 1", () => {
    const result = scoreSpam({
      ...baseInput,
      authenticationResults: "spf=fail; dkim=fail; dmarc=fail",
      headerFrom: createEmailAddress("ceo@other.com"),
      bodyText: "one two three four",
      phrases: ["one", "two", "three", "four"],
    });
    expect(result.score).toBe(1);
  });
});

describe("isSpam", () => {
  test("is inclusive at the threshold", () => {
    expect(isSpam({ score: 0.6, reasons: [] }, 0.6)).toBe(true);
    expect(isSpam({ score: 0.59, reasons: [] }, 0.6)).toBe(false);
  });
});
