import { describe, expect, test } from "vitest";
import { clampFrameHeight, MAX_FRAME_HEIGHT_PX } from "./html-body-frame";

describe("clampFrameHeight", () => {
  test("passes ordinary heights through", () => {
    expect(clampFrameHeight(640)).toBe(640);
  });

  test("raises tiny heights to the floor", () => {
    expect(clampFrameHeight(10)).toBe(120);
  });

  test("caps huge heights so the frame scrolls internally", () => {
    expect(clampFrameHeight(5_000_000)).toBe(MAX_FRAME_HEIGHT_PX);
    expect(MAX_FRAME_HEIGHT_PX).toBe(30000);
  });
});
