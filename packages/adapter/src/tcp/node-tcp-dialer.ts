import * as net from "node:net";
import * as tls from "node:tls";
import type {
  TcpDialer,
  TcpDialOptions,
  TextSocket,
} from "@flying-mail/application/ports/external-mail";
import { ChunkedLineBuffer } from "./chunked-line-buffer";

/** Wires a `net.Socket`'s (or `tls.TLSSocket`'s -- it extends `net.Socket`)
 * `data`/`end`/`close`/`error` events onto `buffer`. Called once per
 * physical connection: the plaintext socket at dial time, and again on the
 * upgraded `tls.TLSSocket` after `startTls()`. */
function attach(socket: net.Socket, buffer: ChunkedLineBuffer): void {
  socket.on("data", (chunk: Buffer) => buffer.push(chunk));
  socket.on("end", () => buffer.end());
  socket.on("close", () => buffer.end());
  socket.on("error", (error: Error) => buffer.fail(error));
}

function connectPlain(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

function connectTls(host: string, port: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

function upgradeToTls(plainSocket: net.Socket): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    // The plain socket's own listeners are removed before handing it to
    // `tls.connect({ socket })`: otherwise they would keep receiving the
    // now-encrypted bytes in parallel with the new `TLSSocket`, double
    // "reading" the same connection.
    plainSocket.removeAllListeners();
    const secureSocket = tls.connect({ socket: plainSocket }, () =>
      resolve(secureSocket),
    );
    secureSocket.once("error", reject);
  });
}

class NodeTextSocket implements TextSocket {
  private buffer: ChunkedLineBuffer;
  private socket: net.Socket;
  private readonly tlsReady: boolean;

  constructor(socket: net.Socket, opts: TcpDialOptions) {
    this.socket = socket;
    this.tlsReady = opts.tls === "starttls-ready";
    this.buffer = new ChunkedLineBuffer();
    attach(socket, this.buffer);
  }

  readLine(): Promise<string | null> {
    return this.buffer.readLine();
  }

  readBytes(length: number): Promise<Uint8Array> {
    return this.buffer.readBytes(length);
  }

  async write(data: string | Uint8Array): Promise<void> {
    const chunk = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
    await new Promise<void>((resolve, reject) => {
      this.socket.write(chunk, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async startTls(): Promise<void> {
    if (!this.tlsReady) {
      throw new Error('startTls() requires dialing with tls: "starttls-ready"');
    }
    const upgraded = await upgradeToTls(this.socket);
    this.socket = upgraded;
    this.buffer = new ChunkedLineBuffer();
    attach(upgraded, this.buffer);
  }

  async close(): Promise<void> {
    this.socket.destroy();
  }
}

/** `node:net`/`node:tls`-backed `TcpDialer`. Used both by the Bun/Node
 * server runtime and, since Bun runs `node:net`/`node:tls` through the same
 * compatibility layer, by tests that want a real loopback socket rather
 * than `tcp/fake-socket.ts`. Never imports `cloudflare:sockets`, so it is
 * import-safe under Workers too (it would simply never be selected there by
 * the composition root). */
export function createNodeTcpDialer(): TcpDialer {
  return {
    async dial(opts) {
      const socket =
        opts.tls === "implicit"
          ? await connectTls(opts.host, opts.port)
          : await connectPlain(opts.host, opts.port);
      return new NodeTextSocket(socket, opts);
    },
  };
}
