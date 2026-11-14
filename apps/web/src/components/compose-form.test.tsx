import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AttachmentView } from "../api/schema-types";
import type {
  ComposeAttachmentChip,
  ComposeInitialState,
} from "../lib/compose-types";
import {
  ComposeForm,
  type ComposeSaveResult,
  type ComposeSubmit,
} from "./compose-form";

const upload = vi.hoisted(() => vi.fn());
vi.mock("../lib/upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/upload")>();
  return { ...actual, uploadAttachmentWithProgress: upload };
});

const baseInitial: ComposeInitialState = {
  title: "New message",
  draftId: null,
  from: "me@example.com",
  replyTo: null,
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  html: "",
  text: "",
  inReplyToMessageId: null,
  forwardedFromMessageId: null,
  attachments: [],
};

const noLimits = {
  maxAttachmentBytes: 5 * 1024 * 1024,
  maxOutboundTotalBytes: 5 * 1024 * 1024,
  maxAttachmentsPerMessage: 32,
  maxRecipientsPerMessage: 50,
};

function mount(
  options: {
    initial?: ComposeInitialState;
    sendableAddresses?: readonly string[];
    limits?: typeof noLimits;
    onSend?: (content: ComposeSubmit) => Promise<"sent" | "failed">;
    onSave?: (content: ComposeSubmit) => Promise<ComposeSaveResult>;
    onClose?: () => void;
  } = {},
): { container: HTMLElement; dispose: () => void; send: () => void } {
  const sendableAddresses = options.sendableAddresses ?? ["me@example.com"];
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = render(
    () => (
      <ComposeForm
        initial={options.initial ?? baseInitial}
        sendableAddresses={sendableAddresses}
        limits={options.limits ?? noLimits}
        onSend={options.onSend ?? (async () => "sent")}
        onSave={options.onSave ?? (async () => ({ kind: "saved" }))}
        onDiscard={async () => undefined}
        onClose={options.onClose ?? (() => undefined)}
      />
    ),
    container,
  );
  return {
    container,
    dispose: () => {
      dispose();
      container.remove();
    },
    send: () =>
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
  };
}

function input(container: HTMLElement, selector: string, value: string): void {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector,
  );
  if (field === null) throw new Error(`Field missing: ${selector}`);
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function submitButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  );
  if (button === null) throw new Error("Send button missing");
  return button;
}

function attachment(overrides: Partial<AttachmentView> = {}): AttachmentView {
  return {
    id: "adopted-1",
    fileName: "forward.pdf",
    contentType: "application/pdf",
    size: 10,
    inline: false,
    kind: "PDF",
    contentId: null,
    url: "",
    ...overrides,
  };
}

function chip(
  overrides: Partial<ComposeAttachmentChip> = {},
): ComposeAttachmentChip {
  return {
    localKey: "file-1",
    id: "file-id",
    fileName: "file.txt",
    contentType: "text/plain",
    size: 10,
    origin: "upload",
    status: "done",
    progress: 100,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useRealTimers();
  upload.mockReset();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ComposeForm", () => {
  test("groups the active From addresses supplied by ComposeHost", () => {
    const view = mount({
      sendableAddresses: ["me@active.example"],
    });
    const groups = Array.from(
      view.container.querySelectorAll<HTMLOptGroupElement>(
        "#compose-from optgroup",
      ),
    ).map((group) => group.label);
    expect(groups).toEqual(["active.example"]);
    expect(
      view.container.querySelector("#compose-from")?.textContent,
    ).not.toContain("pending.example");
    view.dispose();
  });

  test("does not derive a local part from a wildcard initial From", () => {
    const view = mount({
      initial: { ...baseInitial, from: "*@alpha.example" },
      sendableAddresses: ["*@alpha.example"],
    });
    expect(
      view.container.querySelector<HTMLInputElement>("#compose-from-local")
        ?.value,
    ).toBe("");
    view.dispose();
  });

  test("Bcc toggle exposes the field and submits its parsed value", async () => {
    const onSend = vi.fn(async (_content: ComposeSubmit) => "sent" as const);
    const view = mount({ onSend });
    input(view.container, "#compose-to", "you@example.com");
    view.container
      .querySelector<HTMLButtonElement>(".compose-row-toggle:nth-of-type(2)")
      ?.click();
    input(
      view.container,
      "#compose-bcc",
      "hidden@example.com; other@example.com",
    );
    view.send();
    await Promise.resolve();
    await Promise.resolve();
    expect(onSend.mock.calls[0]?.[0].bcc).toEqual([
      "hidden@example.com",
      "other@example.com",
    ]);
    view.dispose();
  });

  test("pattern From uses a local part and disables send for an invalid value", async () => {
    const onSend = vi.fn(async (_content: ComposeSubmit) => "sent" as const);
    const view = mount({
      initial: { ...baseInitial, from: "*@T" },
      sendableAddresses: ["*@T"],
      onSend,
    });
    input(view.container, "#compose-from-local", "a");
    input(view.container, "#compose-to", "you@example.com");
    view.send();
    await Promise.resolve();
    await Promise.resolve();
    expect(onSend.mock.calls[0]?.[0].from).toBe("a@T");
    input(view.container, "#compose-from-local", "a@T");
    expect(submitButton(view.container).disabled).toBe(true);
    view.dispose();
  });

  test("a concrete initial From matching a wildcard selects that pattern", async () => {
    const onSend = vi.fn(async (_content: ComposeSubmit) => "sent" as const);
    const view = mount({
      initial: { ...baseInitial, from: "support@T" },
      sendableAddresses: ["*@T"],
      onSend,
    });
    expect(
      view.container.querySelector<HTMLSelectElement>("#compose-from")?.value,
    ).toBe("*@T");
    expect(
      view.container.querySelector<HTMLInputElement>("#compose-from-local")
        ?.value,
    ).toBe("support");
    input(view.container, "#compose-to", "you@example.com");
    view.send();
    await Promise.resolve();
    expect(onSend.mock.calls[0]?.[0].from).toBe("support@T");
    view.dispose();
  });

  test("HTML submits sanitized html and text, plain mode submits text only", async () => {
    const onSend = vi.fn(async (_content: ComposeSubmit) => "sent" as const);
    const view = mount({ onSend });
    input(view.container, "#compose-to", "you@example.com");
    const editor = view.container.querySelector<HTMLElement>(
      "[contenteditable=true]",
    );
    if (editor === null) throw new Error("editor missing");
    editor.innerHTML =
      '<p>Hello <img src="https://remote" onerror="alert(1)"></p>';
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    view.send();
    await Promise.resolve();
    await Promise.resolve();
    expect(onSend.mock.calls[0]?.[0].html).toBe("<p>Hello </p>");
    expect(onSend.mock.calls[0]?.[0].text).toBe("Hello");
    view.dispose();

    const plainView = mount({ onSend });
    input(plainView.container, "#compose-to", "you@example.com");
    const plainEditor = plainView.container.querySelector<HTMLElement>(
      "[contenteditable=true]",
    );
    if (plainEditor === null) throw new Error("editor missing");
    plainEditor.innerHTML = "<p>Hello</p>";
    plainEditor.dispatchEvent(new Event("input", { bubbles: true }));
    onSend.mockClear();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    plainView.container
      .querySelector<HTMLButtonElement>('button[aria-label="Use plain text"]')
      ?.click();
    plainView.send();
    await Promise.resolve();
    await Promise.resolve();
    expect(onSend.mock.calls[0]?.[0].html).toBeNull();
    expect(onSend.mock.calls[0]?.[0].text).toBe("Hello");
    plainView.dispose();
  });

  test("uploading chip disables Send and removing a done chip removes its id", async () => {
    const uploading = new Promise<never>(() => undefined);
    upload.mockReturnValue({ promise: uploading, abort: vi.fn() });
    const view = mount({
      initial: {
        ...baseInitial,
        to: ["you@example.com"],
        attachments: [chip({ status: "uploading", id: null })],
      },
    });
    expect(submitButton(view.container).disabled).toBe(true);
    view.dispose();
    const onSend = vi.fn(async (_content: ComposeSubmit) => "sent" as const);
    const done = mount({
      initial: {
        ...baseInitial,
        to: ["you@example.com"],
        attachments: [chip()],
      },
      onSend,
    });
    done.container
      .querySelector<HTMLButtonElement>('button[aria-label="Remove file.txt"]')
      ?.click();
    done.send();
    await Promise.resolve();
    expect(onSend.mock.calls[0]?.[0].attachmentIds).toEqual([]);
    done.dispose();
  });

  test("oversize file is rejected before upload and displays an error", () => {
    const view = mount({ limits: { ...noLimits, maxAttachmentBytes: 1 } });
    const file = new File(["too large"], "large.txt", { type: "text/plain" });
    Object.defineProperty(
      view.container.querySelector("input[type=file]"),
      "files",
      { value: [file] },
    );
    view.container
      .querySelector<HTMLInputElement>("input[type=file]")
      ?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(upload).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("exceeds");
    view.dispose();
  });

  test("forward attachment moves from forward ids to attachment ids after autosave adoption", async () => {
    vi.useFakeTimers();
    const forwardChip = chip({
      localKey: "forward-1",
      id: null,
      fileName: "forward.pdf",
      origin: "forward",
      sourceAttachmentId: "source-1",
    });
    const onSave = vi.fn(
      async (_content: ComposeSubmit) =>
        ({
          kind: "saved",
          draftId: "draft-1",
          attachments: [attachment()],
        }) as const,
    );
    const onSend = vi.fn(async (_content: ComposeSubmit) => "sent" as const);
    const view = mount({
      initial: {
        ...baseInitial,
        to: ["you@example.com"],
        forwardedFromMessageId: "message-1",
        attachments: [forwardChip],
      },
      onSave,
      onSend,
    });
    input(view.container, "#compose-subject", "Edited");
    await vi.advanceTimersByTimeAsync(2000);
    expect(onSave.mock.calls[0]?.[0].forwardAttachmentIds).toEqual([
      "source-1",
    ]);
    view.send();
    await Promise.resolve();
    expect(onSend.mock.calls[0]?.[0].attachmentIds).toEqual(["adopted-1"]);
    expect(onSend.mock.calls[0]?.[0].forwardAttachmentIds).toEqual([]);
    view.dispose();
  });

  test("a queued change saves with the draft id created by the in-flight save", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((result: ComposeSaveResult) => void) | undefined;
    const onSave = vi
      .fn<(content: ComposeSubmit) => Promise<ComposeSaveResult>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ kind: "saved", draftId: "draft-created" });
    const view = mount({ onSave });
    input(view.container, "#compose-subject", "First edit");
    await vi.advanceTimersByTimeAsync(2000);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0].draftId).toBeNull();
    input(view.container, "#compose-subject", "Queued edit");
    resolveFirst?.({ kind: "saved", draftId: "draft-created" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0].draftId).toBe("draft-created");
    view.dispose();
  });

  test("forward adoption claims each returned attachment id at most once", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(
      async (_content: ComposeSubmit) =>
        ({
          kind: "saved",
          draftId: "draft-1",
          attachments: [attachment()],
        }) as const,
    );
    const onSend = vi.fn(async (_content: ComposeSubmit) => "sent" as const);
    const view = mount({
      initial: {
        ...baseInitial,
        to: ["you@example.com"],
        forwardedFromMessageId: "message-1",
        attachments: [
          chip({
            localKey: "forward-1",
            id: null,
            fileName: "forward.pdf",
            origin: "forward",
            sourceAttachmentId: "source-1",
          }),
          chip({
            localKey: "forward-2",
            id: null,
            fileName: "forward.pdf",
            origin: "forward",
            sourceAttachmentId: "source-2",
          }),
        ],
      },
      onSave,
      onSend,
    });
    input(view.container, "#compose-subject", "Trigger adoption");
    await vi.advanceTimersByTimeAsync(2000);
    view.send();
    await Promise.resolve();
    expect(onSend.mock.calls[0]?.[0].attachmentIds).toEqual(["adopted-1"]);
    expect(onSend.mock.calls[0]?.[0].forwardAttachmentIds).toEqual([
      "source-2",
    ]);
    view.dispose();
  });

  test("forward adoption does not claim an id already used by an upload chip", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(
      async (_content: ComposeSubmit) =>
        ({
          kind: "saved",
          draftId: "draft-1",
          attachments: [attachment({ id: "shared-id" })],
        }) as const,
    );
    const onSend = vi.fn(async (_content: ComposeSubmit) => "sent" as const);
    const view = mount({
      initial: {
        ...baseInitial,
        to: ["you@example.com"],
        forwardedFromMessageId: "message-1",
        attachments: [
          chip({
            id: "shared-id",
            fileName: "forward.pdf",
            contentType: "application/pdf",
          }),
          chip({
            localKey: "forward-1",
            id: null,
            fileName: "forward.pdf",
            contentType: "application/pdf",
            origin: "forward",
            sourceAttachmentId: "source-1",
          }),
        ],
      },
      onSave,
      onSend,
    });
    input(view.container, "#compose-subject", "Trigger adoption");
    await vi.advanceTimersByTimeAsync(2000);
    view.send();
    await Promise.resolve();
    expect(onSend.mock.calls[0]?.[0].attachmentIds).toEqual(["shared-id"]);
    expect(onSend.mock.calls[0]?.[0].forwardAttachmentIds).toEqual([
      "source-1",
    ]);
    view.dispose();
  });

  test("does not autosave while a recipient entry is incomplete", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(
      async (_content: ComposeSubmit) => ({ kind: "saved" }) as const,
    );
    const onClose = vi.fn();
    const view = mount({ onSave, onClose });
    input(view.container, "#compose-to", "bob");
    input(view.container, "#compose-subject", "Typing");
    await vi.advanceTimersByTimeAsync(3000);
    expect(onSave).not.toHaveBeenCalled();
    view.container
      .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
      ?.click();
    await Promise.resolve();
    expect(onClose).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("Not saved");
    view.dispose();
  });

  test("keeps the window open after a failed close flush and offers retry or discard", async () => {
    vi.useFakeTimers();
    const onSave = vi
      .fn<(content: ComposeSubmit) => Promise<ComposeSaveResult>>()
      .mockResolvedValueOnce({ kind: "error", message: "offline" })
      .mockResolvedValue({ kind: "saved" });
    const onClose = vi.fn();
    const view = mount({ onSave, onClose });
    input(view.container, "#compose-subject", "Keep this draft");
    view.container
      .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
      ?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("Not saved");
    expect(view.container.textContent).toContain("Retry");
    expect(view.container.textContent).toContain("Discard");

    view.container
      .querySelector<HTMLButtonElement>(".compose-field-error button")
      ?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onSave).toHaveBeenCalledTimes(2);
    view.dispose();
  });

  test("successful send closes compose and prevents a second send", async () => {
    const onSend = vi.fn(async (_content: ComposeSubmit) => "sent" as const);
    const onClose = vi.fn();
    const view = mount({ onSend, onClose });
    input(view.container, "#compose-to", "you@example.com");
    view.send();
    await Promise.resolve();
    await Promise.resolve();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(submitButton(view.container).disabled).toBe(true);
    view.send();
    await Promise.resolve();
    expect(onSend).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  test("removing an uploading chip aborts its request", () => {
    const abort = vi.fn();
    const pending = new Promise<never>(() => undefined);
    upload.mockReturnValue({ promise: pending, abort });
    const view = mount();
    const file = new File(["content"], "upload.txt", { type: "text/plain" });
    Object.defineProperty(
      view.container.querySelector("input[type=file]"),
      "files",
      {
        value: [file],
      },
    );
    view.container
      .querySelector<HTMLInputElement>("input[type=file]")
      ?.dispatchEvent(new Event("change", { bubbles: true }));
    view.container
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Remove upload.txt"]',
      )
      ?.click();
    expect(abort).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  test("unmounting a dirty form flushes exactly one draft save", async () => {
    const onSave = vi.fn(
      async (_content: ComposeSubmit) => ({ kind: "saved" }) as const,
    );
    const view = mount({ onSave });
    input(view.container, "#compose-subject", "Save on unmount");

    view.dispose();
    await Promise.resolve();
    await Promise.resolve();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0].subject).toBe("Save on unmount");
  });

  test("autosaves once after two seconds and send cancels pending autosave", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(
      async (_content: ComposeSubmit) => ({ kind: "saved" }) as const,
    );
    let sendStarted = false;
    const onSend = vi.fn(async (_content: ComposeSubmit) => {
      sendStarted = true;
      return "sent" as const;
    });
    const view = mount({ onSave, onSend });
    input(view.container, "#compose-to", "you@example.com");
    input(view.container, "#compose-subject", "Autosave me");
    await vi.advanceTimersByTimeAsync(2000);
    expect(onSave).toHaveBeenCalledTimes(1);
    input(view.container, "#compose-subject", "Send me");
    view.send();
    await Promise.resolve();
    await Promise.resolve();
    expect(sendStarted).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onSave).toHaveBeenCalledTimes(1);
    view.dispose();
  });
});
