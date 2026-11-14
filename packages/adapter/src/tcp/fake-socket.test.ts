import { describe, expect, test } from "vitest";
import { fakeTcpDialer, STARTTLS_MARKER } from "./fake-socket";

describe("fake-socket", () => {
  test("serves scripted server lines one at a time, then EOF", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({ serverLines: ["+OK greeting", "+OK USER ok"] });
    const socket = await dialer.dial({
      host: "pop.example.com",
      port: 995,
      tls: "implicit",
    });

    expect(await socket.readLine()).toBe("+OK greeting");
    expect(await socket.readLine()).toBe("+OK USER ok");
    expect(await socket.readLine()).toBeNull();
  });

  test("failDialWith fails only the next dial() call", async () => {
    const dialer = fakeTcpDialer();
    const boom = new Error("connection refused");
    dialer.queueScript({ failDialWith: boom });
    dialer.queueScript({ serverLines: ["+OK"] });

    await expect(
      dialer.dial({ host: "h", port: 995, tls: "implicit" }),
    ).rejects.toBe(boom);

    const socket = await dialer.dial({ host: "h", port: 995, tls: "implicit" });
    expect(await socket.readLine()).toBe("+OK");
  });

  test("writes and dialedWith are append-only and shared across sockets", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({ serverLines: [] });
    dialer.queueScript({ serverLines: [] });
    const first = await dialer.dial({ host: "a", port: 995, tls: "implicit" });
    await first.write("USER taco\r\n");
    const second = await dialer.dial({ host: "b", port: 995, tls: "implicit" });
    await second.write("PASS secret\r\n");

    expect(dialer.writes).toEqual(["USER taco\r\n", "PASS secret\r\n"]);
    expect(dialer.dialedWith).toEqual([
      { host: "a", port: 995, tls: "implicit" },
      { host: "b", port: 995, tls: "implicit" },
    ]);
  });

  test("multiline UIDL-style response with a lone '.' terminator is delivered verbatim", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({
      serverLines: ["+OK", "1 uid-1", "2 uid-2", "."],
    });
    const socket = await dialer.dial({ host: "h", port: 995, tls: "implicit" });
    const lines: string[] = [];
    for (;;) {
      const line = await socket.readLine();
      if (line === null) break;
      lines.push(line);
      if (line === ".") break;
    }
    expect(lines).toEqual(["+OK", "1 uid-1", "2 uid-2", "."]);
  });

  test("byte-stuffed leading-dot lines are passed through unmodified", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({ serverLines: ["+OK", "..a stuffed line", "."] });
    const socket = await dialer.dial({ host: "h", port: 995, tls: "implicit" });
    await socket.readLine();
    expect(await socket.readLine()).toBe("..a stuffed line");
  });

  test("startTls() records a marker and requires starttls-ready", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({ serverLines: [] });
    dialer.queueScript({ serverLines: [] });

    const ready = await dialer.dial({
      host: "h",
      port: 587,
      tls: "starttls-ready",
    });
    await ready.startTls();
    expect(dialer.writes).toEqual([STARTTLS_MARKER]);

    const implicit = await dialer.dial({
      host: "h",
      port: 995,
      tls: "implicit",
    });
    await expect(implicit.startTls()).rejects.toThrow(
      /dialed with tls: "implicit"/,
    );
  });

  test("close() rejects further operations", async () => {
    const dialer = fakeTcpDialer();
    dialer.queueScript({ serverLines: ["+OK"] });
    const socket = await dialer.dial({ host: "h", port: 995, tls: "implicit" });
    await socket.close();
    await expect(socket.readLine()).rejects.toThrow(/after close/);
    await expect(socket.write("x")).rejects.toThrow(/after close/);
  });
});
