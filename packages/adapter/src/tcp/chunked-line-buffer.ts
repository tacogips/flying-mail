/** A byte buffer with async line/fixed-length read primitives, fed by
 * `push()`/`end()`/`fail()` calls from a transport-specific adapter --
 * Node's `data`/`end`/`error` socket events, or a pump loop draining a
 * Cloudflare `ReadableStreamDefaultReader`. Runtime-agnostic: this file
 * imports neither `node:net`/`node:tls` nor `cloudflare:sockets`, so
 * `node-tcp-dialer.ts` and `cloudflare-tcp-dialer.ts` can both depend on it
 * without either pulling in the other's runtime. */
export class ChunkedLineBuffer {
  private chunks: Uint8Array[] = [];
  private length = 0;
  private closed = false;
  private error: Error | null = null;
  private waiters: Array<() => void> = [];

  /** Feeds newly-arrived bytes in. A zero-length chunk is a no-op. */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.length += chunk.length;
    this.wake();
  }

  /** Marks a clean EOF: no more bytes will ever arrive. */
  end(): void {
    this.closed = true;
    this.wake();
  }

  /** Marks the underlying transport as failed; every pending and future
   * read rejects with `error`. */
  fail(error: Error): void {
    this.error = error;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private async waitForMore(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Merges `chunks` into one, so line-scanning and slicing do not have to
   * reason about chunk boundaries. */
  private coalesce(): Uint8Array {
    if (this.chunks.length <= 1) {
      return this.chunks[0] ?? new Uint8Array(0);
    }
    const merged = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [merged];
    return merged;
  }

  private consume(count: number): Uint8Array {
    const merged = this.coalesce();
    const taken = merged.subarray(0, count);
    this.chunks = count < merged.length ? [merged.subarray(count)] : [];
    this.length -= count;
    return taken;
  }

  /** Resolves with the next `\n`- or `\r\n`-terminated line, without the
   * terminator, or `null` once the buffer is empty and the transport has
   * cleanly ended. A trailing unterminated line at EOF is returned as a
   * final line rather than dropped. */
  async readLine(): Promise<string | null> {
    for (;;) {
      const merged = this.coalesce();
      const newlineIndex = merged.indexOf(0x0a);
      if (newlineIndex !== -1) {
        let contentEnd = newlineIndex;
        if (contentEnd > 0 && merged[contentEnd - 1] === 0x0d) {
          contentEnd -= 1;
        }
        const line = new TextDecoder().decode(merged.subarray(0, contentEnd));
        this.consume(newlineIndex + 1);
        return line;
      }
      if (this.error !== null) {
        throw this.error;
      }
      if (this.closed) {
        if (this.length === 0) {
          return null;
        }
        const line = new TextDecoder().decode(merged);
        this.consume(this.length);
        return line;
      }
      await this.waitForMore();
    }
  }

  /** Resolves with exactly `count` bytes, or fewer if the transport ends
   * (cleanly or via `fail()`) before `count` bytes have arrived. */
  async readBytes(count: number): Promise<Uint8Array> {
    while (this.length < count && this.error === null && !this.closed) {
      await this.waitForMore();
    }
    if (this.error !== null) {
      throw this.error;
    }
    return this.consume(Math.min(count, this.length));
  }
}
