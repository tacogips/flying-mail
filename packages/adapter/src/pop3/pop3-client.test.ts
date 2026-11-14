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
        "+OK",
        "1 50",
        "2 123",
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
        "+OK",
        "1 10",
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
        "+OK",
        "1 10",
        ".",
        "-ERR no such message",
        "+OK bye",
      ],
    });
    const client = createPop3Client(dialer);

    const messages = await client.fetchByUidl(CREDENTIALS, ["uidl-1"]);

    expect(messages).toEqual([]);
  });

  describe("message size cap", () => {
    const HEAD = ["+OK POP3 ready", "+OK user", "+OK pass"];

    test("skips an oversized UIDL named by LIST without sending RETR", async () => {
      const dialer = fakeTcpDialer();
      dialer.queueScript({
        serverLines: [
          ...HEAD,
          "+OK 2 messages",
          "1 big",
          "2 small",
          ".",
          "+OK",
          "1 5000",
          "2 5",
          ".",
          "+OK 5 octets",
          "hello",
          ".",
          "+OK bye",
        ],
      });
      const client = createPop3Client(dialer, { maxMessageBytes: 100 });

      const result = await client.fetchByUidlDetailed(CREDENTIALS, [
        "big",
        "small",
      ]);

      expect(result.skipped).toEqual([
        { remoteId: "big", reason: "TOO_LARGE", size: 5000 },
      ]);
      expect(result.messages.map((m) => m.remoteId)).toEqual(["small"]);
      expect(dialer.writes.filter((w) => w.startsWith("RETR"))).toEqual([
        "RETR 2\r\n",
      ]);
    });

    test("fetchByUidl omits oversized messages", async () => {
      const dialer = fakeTcpDialer();
      dialer.queueScript({
        serverLines: [
          ...HEAD,
          "+OK 1 message",
          "1 big",
          ".",
          "+OK",
          "1 5000",
          ".",
          "+OK bye",
        ],
      });
      const client = createPop3Client(dialer, { maxMessageBytes: 100 });

      await expect(client.fetchByUidl(CREDENTIALS, ["big"])).resolves.toEqual(
        [],
      );
    });

    test("aborts buffering a RETR that outgrows the cap and keeps the session in sync", async () => {
      const dialer = fakeTcpDialer();
      const longLine = "x".repeat(60);
      dialer.queueScript({
        serverLines: [
          ...HEAD,
          "+OK 2 messages",
          "1 liar",
          "2 fine",
          ".",
          // LIST understates the first message.
          "+OK",
          "1 10",
          "2 5",
          ".",
          "+OK",
          longLine,
          longLine,
          longLine,
          ".",
          "+OK",
          "hello",
          ".",
          "+OK bye",
        ],
      });
      const client = createPop3Client(dialer, { maxMessageBytes: 100 });

      const result = await client.fetchByUidlDetailed(CREDENTIALS, [
        "liar",
        "fine",
      ]);

      expect(result.skipped).toEqual([
        { remoteId: "liar", reason: "TOO_LARGE", size: 186 },
      ]);
      expect(result.messages.map((m) => m.remoteId)).toEqual(["fine"]);
    });

    test("gives up with a transport error when a RETR never stops", async () => {
      const dialer = fakeTcpDialer();
      const longLine = "x".repeat(98);
      dialer.queueScript({
        serverLines: [
          ...HEAD,
          "+OK 1 message",
          "1 endless",
          ".",
          "-ERR no LIST",
          "+OK",
          // 4 x 100 byte cap = 400 byte drain limit; 5 lines of 100 bytes.
          ...Array.from({ length: 6 }, () => longLine),
          ".",
          "+OK bye",
        ],
      });
      const client = createPop3Client(dialer, { maxMessageBytes: 100 });

      await expect(
        client.fetchByUidl(CREDENTIALS, ["endless"]),
      ).rejects.toBeInstanceOf(ExternalMailTransportError);
    });

    test("still fetches when the server refuses LIST", async () => {
      const dialer = fakeTcpDialer();
      dialer.queueScript({
        serverLines: [
          ...HEAD,
          "+OK 1 message",
          "1 uidl-1",
          ".",
          "-ERR LIST not supported",
          "+OK",
          "hello",
          ".",
          "+OK bye",
        ],
      });
      const client = createPop3Client(dialer);

      const messages = await client.fetchByUidl(CREDENTIALS, ["uidl-1"]);

      expect(messages.map((m) => m.remoteId)).toEqual(["uidl-1"]);
    });

    test("accepts a message exactly at the cap", async () => {
      const dialer = fakeTcpDialer();
      // 98 chars + CRLF = 100 bytes.
      dialer.queueScript({
        serverLines: [
          ...HEAD,
          "+OK 1 message",
          "1 uidl-1",
          ".",
          "+OK",
          "1 100",
          ".",
          "+OK",
          "y".repeat(98),
          ".",
          "+OK bye",
        ],
      });
      const client = createPop3Client(dialer, { maxMessageBytes: 100 });

      const result = await client.fetchByUidlDetailed(CREDENTIALS, ["uidl-1"]);

      expect(result.skipped).toEqual([]);
      expect(result.messages).toHaveLength(1);
    });
  });
});
