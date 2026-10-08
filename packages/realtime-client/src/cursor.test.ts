import { describe, expect, it } from "vitest";
import { compareCursors } from "./cursor";

describe("compareCursors", () => {
  it("orders sequences within an epoch", () => {
    expect(compareCursors("epoch.4", "epoch.5")).toBe("older");
    expect(compareCursors("epoch.5", "epoch.5")).toBe("same");
    expect(compareCursors("epoch.6", "epoch.5")).toBe("newer");
    expect(
      compareCursors("epoch.9007199254740993", "epoch.9007199254740992"),
    ).toBe("newer");
  });

  it("treats epoch changes and malformed cursors as different epochs", () => {
    expect(compareCursors("first.1", "second.1")).toBe("different-epoch");
    expect(compareCursors("missing-sequence", "first.1")).toBe(
      "different-epoch",
    );
    expect(compareCursors("first.nope", "first.1")).toBe("different-epoch");
  });
});
