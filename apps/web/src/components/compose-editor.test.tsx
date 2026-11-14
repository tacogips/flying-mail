import { render } from "solid-js/web";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ComposeEditor } from "./compose-editor";

function mount(props: Parameters<typeof ComposeEditor>[0]): {
  container: HTMLElement;
  dispose: () => void;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = render(() => <ComposeEditor {...props} />, container);
  return {
    container,
    dispose: () => {
      dispose();
      container.remove();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ComposeEditor", () => {
  test("toolbar dispatches its formatting commands through the injected executor", () => {
    const execute = vi.fn((_command: string, _value?: string) => true);
    vi.spyOn(window, "prompt").mockReturnValue("https://example.com");
    const view = mount({
      initialHtml: "<p>hello</p>",
      initialText: "hello",
      onChange: vi.fn(),
      execCommand: execute,
    });
    for (const label of [
      "Bold",
      "Italic",
      "Underline",
      "Bulleted list",
      "Numbered list",
      "Link",
      "Blockquote",
      "Clear formatting",
    ]) {
      view.container
        .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
        ?.click();
    }
    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      "bold",
      "italic",
      "underline",
      "insertUnorderedList",
      "insertOrderedList",
      "createLink",
      "formatBlock",
      "removeFormat",
      "unlink",
    ]);
    view.dispose();
  });

  test("paste inserts sanitized clipboard HTML", () => {
    const execute = vi.fn((_command: string, _value?: string) => true);
    const view = mount({
      initialHtml: "",
      initialText: "",
      onChange: vi.fn(),
      execCommand: execute,
    });
    const editor = view.container.querySelector<HTMLElement>(
      "[contenteditable=true]",
    );
    if (editor === null) throw new Error("editor not found");
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        getData: (type: string) =>
          type === "text/html"
            ? '<img src="https://x" onerror="alert(1)"><b>safe</b>'
            : "plain",
      },
    });
    editor.dispatchEvent(event);
    expect(execute).toHaveBeenCalledWith("insertHTML", "<b>safe</b>");
    expect(
      execute.mock.calls.some(
        ([command, value]) =>
          command === "insertHTML" && String(value).includes("onerror"),
      ),
    ).toBe(false);
    view.dispose();
  });

  test("plain mode removes formatting buttons and preserves its text", () => {
    const execute = vi.fn((_command: string, _value?: string) => true);
    const onChange = vi.fn();
    const view = mount({
      initialHtml: "<p>hello</p>",
      initialText: "hello",
      onChange,
      execCommand: execute,
    });
    const detachedEditor = view.container.querySelector<HTMLElement>(
      "[contenteditable=true]",
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    view.container
      .querySelector<HTMLButtonElement>('button[aria-label="Use plain text"]')
      ?.click();
    expect(
      view.container.querySelector('button[aria-label="Bold"]'),
    ).toBeNull();
    const textarea = view.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message"]',
    );
    expect(textarea?.value).toBe("hello");
    textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    detachedEditor?.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      mode: "plain",
      html: null,
      text: "hello",
    });
    expect(execute).not.toHaveBeenCalled();
    view.dispose();
  });

  test("drop inserts sanitized clipboard HTML", () => {
    const execute = vi.fn((_command: string, _value?: string) => true);
    const view = mount({
      initialHtml: "",
      initialText: "",
      onChange: vi.fn(),
      execCommand: execute,
    });
    const editor = view.container.querySelector<HTMLElement>(
      "[contenteditable=true]",
    );
    if (editor === null) throw new Error("editor not found");
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        getData: (type: string) =>
          type === "text/html"
            ? '<img src="https://x" onerror="alert(1)"><b>dropped</b>'
            : "plain",
      },
    });
    editor.dispatchEvent(event);
    expect(execute).toHaveBeenCalledWith("insertHTML", "<b>dropped</b>");
    expect(
      execute.mock.calls.some(
        ([command, value]) =>
          command === "insertHTML" && String(value).includes("onerror"),
      ),
    ).toBe(false);
    view.dispose();
  });

  test("refuses javascript links", () => {
    const execute = vi.fn((_command: string, _value?: string) => true);
    vi.spyOn(window, "prompt").mockReturnValue("javascript:alert(1)");
    const view = mount({
      initialHtml: "<p>link text</p>",
      initialText: "link text",
      onChange: vi.fn(),
      execCommand: execute,
    });
    view.container
      .querySelector<HTMLButtonElement>('button[aria-label="Link"]')
      ?.click();
    expect(execute).not.toHaveBeenCalledWith("createLink", expect.anything());
    view.dispose();
  });
});
