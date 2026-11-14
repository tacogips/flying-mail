import * as net from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { createNodeTcpDialer } from "./node-tcp-dialer";

/** Exercises `createNodeTcpDialer()` against a real loopback `net.Server`,
 * per the plan's "a shared conformance test suite... is preferred over two
 * independent suites" -- the Cloudflare dialer's own suite
 * (`cloudflare-tcp-dialer.test.ts`) covers the same `TcpDialer` contract's
 * import-safety outside `workerd`, where it cannot dial for real. */

function startLineEchoServer(
  onLine: (line: string, socket: net.Socket) => void,
): Promise<{ readonly server: net.Server; readonly port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffered = "";
      socket.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf-8");
        let newlineIndex = buffered.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffered.slice(0, newlineIndex).replace(/\r$/, "");
          buffered = buffered.slice(newlineIndex + 1);
          onLine(line, socket);
          newlineIndex = buffered.indexOf("\n");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      resolve({ server, port });
    });
  });
}

describe("node-tcp-dialer", () => {
  let activeServer: net.Server | null = null;

  afterEach(async () => {
    if (activeServer !== null) {
      await new Promise<void>((resolve) =>
        activeServer?.close(() => resolve()),
      );
      activeServer = null;
    }
  });

  test("dials a plaintext loopback server and exchanges lines", async () => {
    const { server, port } = await startLineEchoServer((line, socket) => {
      socket.write(`echo:${line}\r\n`);
    });
    activeServer = server;

    const dialer = createNodeTcpDialer();
    const socket = await dialer.dial({
      host: "127.0.0.1",
      port,
      tls: "starttls-ready",
    });
    try {
      await socket.write("hello\r\n");
      expect(await socket.readLine()).toBe("echo:hello");
    } finally {
      await socket.close();
    }
  });

  test("readLine() resolves null after the server closes the connection", async () => {
    const { server, port } = await startLineEchoServer((_line, socket) => {
      socket.end();
    });
    activeServer = server;

    const dialer = createNodeTcpDialer();
    const socket = await dialer.dial({
      host: "127.0.0.1",
      port,
      tls: "none",
    });
    await socket.write("bye\r\n");
    expect(await socket.readLine()).toBeNull();
  });

  test("dial() rejects when nothing is listening on the port", async () => {
    const dialer = createNodeTcpDialer();
    await expect(
      dialer.dial({ host: "127.0.0.1", port: 1, tls: "none" }),
    ).rejects.toThrow();
  });

  test("startTls() throws when the connection was not dialed starttls-ready", async () => {
    const { server, port } = await startLineEchoServer(() => {});
    activeServer = server;

    const dialer = createNodeTcpDialer();
    const socket = await dialer.dial({ host: "127.0.0.1", port, tls: "none" });
    try {
      await expect(socket.startTls()).rejects.toThrow(/starttls-ready/);
    } finally {
      await socket.close();
    }
  });
});
