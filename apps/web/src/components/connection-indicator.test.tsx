import { render } from "solid-js/web";
import { afterEach, describe, expect, test } from "vitest";
import { ConnectionIndicator } from "./connection-indicator";

function mount(status: "connecting" | "live" | "reconnecting" | "offline") {
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = render(
    () => <ConnectionIndicator status={status} />,
    container,
  );
  return {
    indicator: container.querySelector("[role='status']"),
    dispose: () => {
      dispose();
      container.remove();
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ConnectionIndicator", () => {
  test.each([
    ["live", "Live"],
    ["connecting", "Reconnecting..."],
    ["reconnecting", "Reconnecting..."],
    ["offline", "Offline"],
  ] as const)("labels %s as %s", (status, label) => {
    const view = mount(status);
    expect(view.indicator?.getAttribute("title")).toBe(label);
    expect(view.indicator?.querySelector(".sr-only")?.textContent).toBe(label);
    expect(view.indicator?.hasAttribute("aria-label")).toBe(false);
    view.dispose();
  });
});
