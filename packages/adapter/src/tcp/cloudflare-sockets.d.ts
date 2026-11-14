// Minimal structural surface of `cloudflare:sockets`, the Workers TCP
// socket API. Declared locally (see `blob/r2.ts`/`sql/d1.ts` for the same
// convention) rather than importing the ambient-global
// `@cloudflare/workers-types` package, whose globals this project's
// `tsconfig.json` deliberately excludes (`types: ["bun"]`) so they do not
// collide with Bun's own stream globals used by the rest of
// `@flying-mail/adapter`. Lives in its own ambient `.d.ts` file (rather than
// inside `cloudflare-tcp-dialer.ts` itself) because a `declare module
// "specifier"` block inside a regular module file is treated by TypeScript
// as an *augmentation* of an existing module, which fails to resolve since
// nothing else in this project declares "cloudflare:sockets"; a standalone
// ambient declaration file has no such requirement.
//
// `readable`/`writable` are typed with hand-rolled minimal reader/writer
// interfaces below rather than the DOM `ReadableStream<Uint8Array>`/
// `WritableStream<Uint8Array>` globals: this workspace has more than one
// global declaration of those names in scope (Bun's lib types, plus
// `node:stream/web`'s, pulled in transitively once any file imports
// `node:net`/`node:tls`), and `getReader()`/`getWriter()` on those globals
// are overloaded in ways that do not resolve predictably through
// `ReturnType`. The socket only ever needs `read()`/`write()`, so a minimal
// local shape sidesteps the ambiguity entirely.
declare module "cloudflare:sockets" {
  export interface CloudflareSocketAddress {
    readonly hostname: string;
    readonly port: number;
  }
  export interface CloudflareSocketInfo {
    readonly remoteAddress?: string;
    readonly localAddress?: string;
  }
  export interface CloudflareStreamReadResult {
    readonly done: boolean;
    readonly value?: Uint8Array;
  }
  export interface CloudflareStreamReader {
    read(): Promise<CloudflareStreamReadResult>;
  }
  export interface CloudflareReadableStream {
    getReader(): CloudflareStreamReader;
  }
  export interface CloudflareStreamWriter {
    write(chunk: Uint8Array): Promise<void>;
  }
  export interface CloudflareWritableStream {
    getWriter(): CloudflareStreamWriter;
  }
  export interface CloudflareSocket {
    readonly readable: CloudflareReadableStream;
    readonly writable: CloudflareWritableStream;
    readonly closed: Promise<void>;
    readonly opened: Promise<CloudflareSocketInfo>;
    close(): Promise<void>;
    startTls(): CloudflareSocket;
  }
  export interface CloudflareSocketOptions {
    readonly secureTransport?: "on" | "off" | "starttls";
    readonly allowHalfOpen?: boolean;
  }
  export function connect(
    address: string | CloudflareSocketAddress,
    options?: CloudflareSocketOptions,
  ): CloudflareSocket;
}
