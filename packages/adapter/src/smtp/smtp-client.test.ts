import {
  ExternalMailAuthError,
  ExternalMailTransportError,
} from "@flying-mail/application/ports/external-mail";
import { describe, expect, test } from "vitest";
import { fakeTcpDialer, STARTTLS_MARKER } from "../tcp/fake-socket";
import { createSmtpSubmissionClient } from "./smtp-client";

const IMPLICIT_CREDENTIALS = {
  host: "smtp.example.com",
  port: 465,
  security: "IMPLICIT_TLS" as const,
  username: "taco",
  password: "hunter2",
};

const STARTTLS_CREDENTIALS = {
  host: "smtp.example.com",
  port: 587,
  security: "STARTTLS" as const,
  username: "taco",
  password: "hunter2",
};

describe("smtp-client", () => {
  test("implicit-TLS happy path: EHLO, AUTH PLAIN, MAIL/RCPT/DATA with dot-stuffing", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({
      serverLines: [
        "220 mail.example.com ESMTP",
        "250-mail.example.com",
        "250 AUTH PLAIN LOGIN",
        "235 2.7.0 Authentication successful",
        "250 2.1.0 OK",
        "250 2.1.5 OK",
        "354 Start mail input",
        "250 2.0.0 OK Queued",
        "221 2.0.0 Bye",
      ],
    });
    const client = createSmtpSubmissionClient(dialer);

    await client.send(IMPLICIT_CREDENTIALS, {
      from: "taco@example.com",
      to: ["dest@example.com"],
      raw: "Subject: Hi\r\n\r\n.leading dot\r\nlast line",
    });

    expect(dialer.dialedWith).toEqual([
      { host: "smtp.example.com", port: 465, tls: "implicit" },
    ]);
    expect(dialer.writes).toEqual([
      "EHLO mailcal.invalid\r\n",
      expect.stringMatching(/^AUTH PLAIN /),
      "MAIL FROM:<taco@example.com>\r\n",
      "RCPT TO:<dest@example.com>\r\n",
      "DATA\r\n",
      "Subject: Hi\r\n\r\n..leading dot\r\nlast line\r\n.\r\n",
      "QUIT\r\n",
    ]);
  });

  test("STARTTLS happy path upgrades before the second EHLO and AUTH", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({
      serverLines: [
        "220 mail.example.com ESMTP",
        "250-mail.example.com",
        "250 STARTTLS",
        "220 2.0.0 Ready to start TLS",
        "250-mail.example.com",
        "250 AUTH PLAIN LOGIN",
        "235 2.7.0 Authentication successful",
        "221 2.0.0 Bye",
      ],
    });
    const client = createSmtpSubmissionClient(dialer);

    await client.testConnection(STARTTLS_CREDENTIALS);

    expect(dialer.dialedWith).toEqual([
      { host: "smtp.example.com", port: 587, tls: "starttls-ready" },
    ]);
    const ehloIndexes = dialer.writes
      .map((write, index) =>
        write === "EHLO mailcal.invalid\r\n" ? index : -1,
      )
      .filter((index) => index !== -1);
    const starttlsWriteIndex = dialer.writes.indexOf("STARTTLS\r\n");
    const upgradeIndex = dialer.writes.indexOf(STARTTLS_MARKER);
    const authIndex = dialer.writes.findIndex((write) =>
      write.startsWith("AUTH PLAIN"),
    );
    expect(ehloIndexes).toHaveLength(2);
    expect(ehloIndexes[0]).toBeLessThan(starttlsWriteIndex);
    expect(starttlsWriteIndex).toBeLessThan(upgradeIndex);
    expect(upgradeIndex).toBeLessThan(ehloIndexes[1] ?? -1);
    expect(ehloIndexes[1]).toBeLessThan(authIndex);
  });

  test("falls back to AUTH LOGIN on a 504 reply to AUTH PLAIN", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({
      serverLines: [
        "220 mail.example.com ESMTP",
        "250-mail.example.com",
        "250 AUTH LOGIN",
        "504 5.7.4 Unrecognized authentication type",
        "334 VXNlcm5hbWU6",
        "334 UGFzc3dvcmQ6",
        "235 2.7.0 Authentication successful",
        "221 2.0.0 Bye",
      ],
    });
    const client = createSmtpSubmissionClient(dialer);

    await client.testConnection(IMPLICIT_CREDENTIALS);

    const authPlainIndex = dialer.writes.findIndex((w) =>
      w.startsWith("AUTH PLAIN"),
    );
    const authLoginIndex = dialer.writes.indexOf("AUTH LOGIN\r\n");
    expect(authPlainIndex).toBeGreaterThanOrEqual(0);
    expect(authLoginIndex).toBeGreaterThan(authPlainIndex);
    expect(dialer.writes[authLoginIndex + 1]).toBe(`${btoa("taco")}\r\n`);
    expect(dialer.writes[authLoginIndex + 2]).toBe(`${btoa("hunter2")}\r\n`);
  });

  test("a non-504 AUTH PLAIN rejection raises ExternalMailAuthError without falling back", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({
      serverLines: [
        "220 mail.example.com ESMTP",
        "250-mail.example.com",
        "250 AUTH PLAIN",
        "535 5.7.8 Authentication credentials invalid",
        "221 2.0.0 Bye",
      ],
    });
    const client = createSmtpSubmissionClient(dialer);

    await expect(
      client.testConnection(IMPLICIT_CREDENTIALS),
    ).rejects.toBeInstanceOf(ExternalMailAuthError);
    expect(dialer.writes.some((w) => w === "AUTH LOGIN\r\n")).toBe(false);
  });

  test("a rejected RCPT TO is mapped to ExternalMailTransportError", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({
      serverLines: [
        "220 mail.example.com ESMTP",
        "250-mail.example.com",
        "250 AUTH PLAIN",
        "235 2.7.0 Authentication successful",
        "250 2.1.0 OK",
        "550 5.1.1 User unknown",
        "221 2.0.0 Bye",
      ],
    });
    const client = createSmtpSubmissionClient(dialer);

    await expect(
      client.send(IMPLICIT_CREDENTIALS, {
        from: "taco@example.com",
        to: ["nobody@example.com"],
        raw: "Subject: Hi\r\n\r\nBody\r\n",
      }),
    ).rejects.toBeInstanceOf(ExternalMailTransportError);
    expect(dialer.writes.some((w) => w === "DATA\r\n")).toBe(false);
  });

  test("sends one RCPT TO per envelope recipient", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({
      serverLines: [
        "220 mail.example.com ESMTP",
        "250-mail.example.com",
        "250 AUTH PLAIN",
        "235 2.7.0 Authentication successful",
        "250 2.1.0 OK",
        "250 2.1.5 OK",
        "250 2.1.5 OK",
        "354 Start mail input",
        "250 2.0.0 OK Queued",
        "221 2.0.0 Bye",
      ],
    });
    const client = createSmtpSubmissionClient(dialer);

    await client.send(IMPLICIT_CREDENTIALS, {
      from: "taco@example.com",
      to: ["a@example.com", "b@example.com"],
      raw: "Subject: Hi\r\n\r\nBody\r\n",
    });

    expect(dialer.writes.filter((w) => w.startsWith("RCPT TO:"))).toEqual([
      "RCPT TO:<a@example.com>\r\n",
      "RCPT TO:<b@example.com>\r\n",
    ]);
  });

  test("the dot-stuffed terminator is written exactly once for a body ending in a newline", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({
      serverLines: [
        "220 mail.example.com ESMTP",
        "250-mail.example.com",
        "250 AUTH PLAIN",
        "235 2.7.0 Authentication successful",
        "250 2.1.0 OK",
        "250 2.1.5 OK",
        "354 Start mail input",
        "250 2.0.0 OK Queued",
        "221 2.0.0 Bye",
      ],
    });
    const client = createSmtpSubmissionClient(dialer);

    await client.send(IMPLICIT_CREDENTIALS, {
      from: "taco@example.com",
      to: ["dest@example.com"],
      raw: "Subject: Hi\r\n\r\nBody\r\n",
    });

    const bodyWrite = dialer.writes.find((w) => w.startsWith("Subject:"));
    expect(bodyWrite).toBe("Subject: Hi\r\n\r\nBody\r\n.\r\n");
  });

  test("connection failures map to ExternalMailTransportError", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({ failDialWith: new Error("ECONNREFUSED") });
    const client = createSmtpSubmissionClient(dialer);

    await expect(
      client.testConnection(IMPLICIT_CREDENTIALS),
    ).rejects.toBeInstanceOf(ExternalMailTransportError);
  });

  test("the password never appears in any thrown error's message", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({
      serverLines: [
        "220 mail.example.com ESMTP",
        "250-mail.example.com",
        "250 AUTH PLAIN",
        "535 5.7.8 Authentication credentials invalid",
        "221 2.0.0 Bye",
      ],
    });
    const client = createSmtpSubmissionClient(dialer);

    await expect(client.testConnection(IMPLICIT_CREDENTIALS)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error && !error.message.includes("hunter2"),
    );
  });
});
