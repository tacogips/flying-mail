import { describe, expect, test } from "vitest";
import { enforceBodyLimit } from "./body-limit";

describe("request body byte budgets", () => {
  test.each([undefined, "1", "invalid"])(
    "cancels a body over budget with declared length %s",
    async (declaredLength) => {
      let cancelled = false;
      let reads = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          reads += 1;
          controller.enqueue(new Uint8Array(64));
        },
        cancel() {
          cancelled = true;
        },
      });
      const request = new Request("https://example.com/graphql", {
        method: "POST",
        headers:
          declaredLength === undefined
            ? {}
            : { "content-length": declaredLength },
        body,
        duplex: "half",
      } as RequestInit);

      await expect(enforceBodyLimit(request, 100)).resolves.toEqual({
        kind: "too-large",
      });
      expect(cancelled).toBe(true);
      expect(reads).toBeLessThanOrEqual(3);
    },
  );

  test("preserves a body exactly at the limit and drops untrusted framing", async () => {
    const result = await enforceBodyLimit(
      new Request("https://example.com/graphql", {
        method: "POST",
        headers: { "content-length": "1", "content-type": "application/json" },
        body: "1234",
      }),
      4,
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("Expected accepted body");
    expect(await result.request.text()).toBe("1234");
    expect(result.request.headers.has("content-length")).toBe(false);
    expect(result.request.headers.get("content-type")).toBe("application/json");
  });
});
