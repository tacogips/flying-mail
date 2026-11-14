import { describe, expect, test } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import {
  clampFrameHeight,
  HtmlBodyFrame,
  MAX_FRAME_HEIGHT_PX,
} from "./html-body-frame";

test("remote image consent does not carry over to another message with the same body", () => {
  const [messageId, setMessageId] = createSignal("first-message");
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = render(
    () => (
      <HtmlBodyFrame
        messageId={messageId()}
        html={'<img src="https://tracker.example/pixel">'}
      />
    ),
    container,
  );
  try {
    const frame = container.querySelector("iframe");
    expect(frame?.srcdoc).toContain("img-src data:");
    container.querySelector("button")?.click();
    expect(frame?.srcdoc).toContain("img-src https: data:");
    setMessageId("second-message");
    expect(frame?.srcdoc).toContain("img-src data:");
    expect(container.querySelector("button")?.textContent).toBe("Load images");
  } finally {
    dispose();
    container.remove();
  }
});

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
