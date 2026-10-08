import { describe, expect, test, vi } from "vitest";
import { MAX_FRAME_BYTES, parseClientMessage } from "./protocol";

describe("parseClientMessage", () => {
  test("accepts a frame at the byte limit", () => {
    const prefix = '{"type":"ping","payload":"';
    const frame = `${prefix}${"a".repeat(MAX_FRAME_BYTES - new TextEncoder().encode(prefix).byteLength - 2)}"}`;
    expect(new TextEncoder().encode(frame).byteLength).toBe(MAX_FRAME_BYTES);
    expect(parseClientMessage(frame)).toEqual({
      ok: true,
      message: {
        type: "ping",
        payload: "a".repeat(
          MAX_FRAME_BYTES - new TextEncoder().encode(prefix).byteLength - 2,
        ),
      },
    });
  });

  test("rejects an oversized UTF-8 frame before parsing", () => {
    const result = parseClientMessage(`${" ".repeat(MAX_FRAME_BYTES)}x`);
    expect(result).toEqual({ ok: false, error: "TOO_BIG" });
  });

  test("returns TOO_BIG before UTF-8 encoding for a very long string", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    expect(parseClientMessage("x".repeat(MAX_FRAME_BYTES + 1))).toEqual({
      ok: false,
      error: "TOO_BIG",
    });
    expect(encode).not.toHaveBeenCalled();
    encode.mockRestore();
  });

  test.each(["{", "null", "[]", "{}", '{"type":1}', '{"type":"ping","id":1}'])(
    "rejects malformed JSON protocol messages: %s",
    (frame) =>
      expect(parseClientMessage(frame)).toEqual({
        ok: false,
        error: "BAD_REQUEST",
      }),
  );

  test("rejects binary frames", () => {
    expect(parseClientMessage(new ArrayBuffer(2))).toEqual({
      ok: false,
      error: "BAD_REQUEST",
    });
  });
});
