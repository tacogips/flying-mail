import type {
  TcpDialer,
  TcpDialOptions,
  TextSocket,
  TlsMode,
} from "@flying-mail/application/ports/external-mail";
// `import type` is erased at compile time, so this never becomes a runtime
// import: merely loading this file on Bun/Node -- which has no
// "cloudflare:sockets" module -- does not throw. The ambient module type
// itself lives in `cloudflare-sockets.d.ts` next to this file.
import type {
  CloudflareSocket,
  CloudflareStreamReader,
  CloudflareStreamWriter,
} from "cloudflare:sockets";
import { ChunkedLineBuffer } from "./chunked-line-buffer";

function toSecureTransport(mode: TlsMode): "on" | "off" | "starttls" {
  switch (mode) {
    case "implicit":
      return "on";
    case "starttls-ready":
      return "starttls";
    case "none":
      return "off";
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unhandled TLS mode: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Pumps a `CloudflareStreamReader` into `buffer` until the stream ends or
 * errors. Runs detached (fire-and-forget): both outcomes are reported
 * through `buffer` itself, so nothing needs to await this loop directly. */
async function pump(
  reader: CloudflareStreamReader,
  buffer: ChunkedLineBuffer,
): Promise<void> {
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buffer.end();
        return;
      }
      if (value !== undefined) {
        buffer.push(value);
      }
    }
  } catch (error) {
    buffer.fail(error instanceof Error ? error : new Error(String(error)));
  }
}

class CloudflareTextSocket implements TextSocket {
  private buffer: ChunkedLineBuffer;
  private socket: CloudflareSocket;
  private writer: CloudflareStreamWriter;
  private readonly tlsReady: boolean;

  constructor(socket: CloudflareSocket, opts: TcpDialOptions) {
    this.socket = socket;
    this.tlsReady = opts.tls === "starttls-ready";
    this.buffer = new ChunkedLineBuffer();
    this.writer = socket.writable.getWriter();
    void pump(socket.readable.getReader(), this.buffer);
  }

  readLine(): Promise<string | null> {
    return this.buffer.readLine();
  }

  readBytes(length: number): Promise<Uint8Array> {
    return this.buffer.readBytes(length);
  }

  async write(data: string | Uint8Array): Promise<void> {
    const chunk =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    await this.writer.write(chunk);
  }

  async startTls(): Promise<void> {
    if (!this.tlsReady) {
      throw new Error('startTls() requires dialing with tls: "starttls-ready"');
    }
    // `startTls()` hands back a brand new `Socket`; the original's
    // `readable`/`writable` become unusable, so every piece of session
    // state below is rebuilt against the upgraded socket.
    const upgraded = this.socket.startTls();
    this.socket = upgraded;
    this.buffer = new ChunkedLineBuffer();
    this.writer = upgraded.writable.getWriter();
    void pump(upgraded.readable.getReader(), this.buffer);
  }

  async close(): Promise<void> {
    await this.socket.close();
  }
}

/** `cloudflare:sockets`-backed `TcpDialer`, selected by the composition root
 * when running on Workers. Never imports `node:net`/`node:tls`. */
export function createCloudflareTcpDialer(): TcpDialer {
  return {
    async dial(opts) {
      const { connect } = await import("cloudflare:sockets");
      const socket = connect(
        { hostname: opts.host, port: opts.port },
        { secureTransport: toSecureTransport(opts.tls), allowHalfOpen: false },
      );
      await socket.opened;
      return new CloudflareTextSocket(socket, opts);
    },
  };
}
