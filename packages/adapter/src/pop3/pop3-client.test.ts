import {
  ExternalMailAuthError,
  ExternalMailTransportError,
} from "@flying-mail/application/ports/external-mail";
import { describe, expect, test } from "vitest";
import { fakeTcpDialer } from "../tcp/fake-socket";
import { createPop3Client } from "./pop3-client";

const CREDENTIALS = {
  host: "pop.example.com",
  port: 995,
  username: "taco",
  password: "hunter2",
};

describe("pop3-client", () => {
  test("testConnection dials with implicit TLS, greets and authenticates", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({
      serverLines: ["+OK POP3 ready", "+OK user", "+OK pass", "+OK bye"],
    });
    const client = createPop3Client(dialer);

    await client.testConnection(CREDENTIALS);

    expect(dialer.dialedWith).toEqual([
      { host: "pop.example.com", port: 995, tls: "implicit" },
    ]);
    expect(dialer.writes).toEqual([
      "USER taco\r\n",
      "PASS hunter2\r\n",
      "QUIT\r\n",
    ]);
  });

  test("an unexpected greeting is a transport error", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({ serverLines: ["-ERR overloaded", "+OK bye"] });
    const client = createPop3Client(dialer);

    await expect(client.testConnection(CREDENTIALS)).rejects.toThrow(
      ExternalMailTransportError,
    );
  });

  test("a rejected password raises ExternalMailAuthError and never leaks it", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({
      serverLines: [
        "+OK POP3 ready",
        "+OK user",
        "-ERR invalid password",
        "+OK bye",
      ],
    });
    const client = createPop3Client(dialer);

    // The wire write for PASS necessarily carries the password (that is how
    // POP3 auth works); what must never leak the credential is the *thrown
    // error's message*.
    await expect(client.testConnection(CREDENTIALS)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ExternalMailAuthError &&
        !error.message.includes("hunter2"),
    );
  });

  test("connection failures map to ExternalMailTransportError", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({ failDialWith: new Error("ECONNREFUSED") });
    const client = createPop3Client(dialer);

    await expect(client.testConnection(CREDENTIALS)).rejects.toThrow(
      ExternalMailTransportError,
    );
  });

  test("listUidls parses a multiline UIDL response", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({
      serverLines: [
        "+OK POP3 ready",
        "+OK user",
        "+OK pass",
        "+OK 2 messages",
        "1 uidl-1",
        "2 uidl-2",
        ".",
        "+OK bye",
      ],
    });
    const client = createPop3Client(dialer);

    const uidls = await client.listUidls(CREDENTIALS);

    expect(uidls).toEqual(["uidl-1", "uidl-2"]);
    expect(dialer.writes).not.toContain("DELE 1\r\n");
    expect(dialer.writes.some((w) => w.startsWith("DELE"))).toBe(false);
  });

  test("fetchByUidl undoes dot-stuffing and stops at the multiline terminator", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({
      serverLines: [
        "+OK POP3 ready",
        "+OK user",
        "+OK pass",
        "+OK 2 messages",
        "1 uidl-1",
        "2 uidl-2",
        ".",
        "+OK 123 octets",
        "Subject: Test",
        "",
        "..stuffed",
        "body",
        ".",
        "+OK bye",
      ],
    });
    const client = createPop3Client(dialer);

    const messages = await client.fetchByUidl(CREDENTIALS, ["uidl-2"]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.remoteId).toBe("uidl-2");
    expect(new TextDecoder().decode(messages[0]?.raw)).toBe(
      "Subject: Test\r\n\r\n.stuffed\r\nbody\r\n",
    );
    expect(dialer.writes).toContain("RETR 2\r\n");
    expect(dialer.writes.some((w) => w.startsWith("DELE"))).toBe(false);
  });

  test("an id absent from the UIDL listing is skipped without a RETR", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({
      serverLines: [
        "+OK POP3 ready",
        "+OK user",
        "+OK pass",
        "+OK 1 message",
        "1 uidl-1",
        ".",
        "+OK 10 octets",
        "hello",
        ".",
        "+OK bye",
      ],
    });
    const client = createPop3Client(dialer);

    const messages = await client.fetchByUidl(CREDENTIALS, [
      "uidl-1",
      "uidl-gone",
    ]);

    expect(messages.map((m) => m.remoteId)).toEqual(["uidl-1"]);
    expect(dialer.writes.filter((w) => w.startsWith("RETR"))).toEqual([
      "RETR 1\r\n",
    ]);
  });

  test("a -ERR reply to RETR is skipped, not a batch failure", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({
      serverLines: [
        "+OK POP3 ready",
        "+OK user",
        "+OK pass",
        "+OK 1 message",
        "1 uidl-1",
        ".",
        "-ERR no such message",
        "+OK bye",
      ],
    });
    const client = createPop3Client(dialer);

    const messages = await client.fetchByUidl(CREDENTIALS, ["uidl-1"]);

    expect(messages).toEqual([]);
  });
});
