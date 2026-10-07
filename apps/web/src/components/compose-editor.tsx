import { createSignal, onCleanup, Show, type JSX } from "solid-js";
import {
  htmlToPlainText,
  isAllowedLinkUrl,
  plainTextToHtml,
  sanitizeComposeHtml,
} from "../lib/compose-html";
import "./compose-form.css";

export interface ComposeEditorValue {
  readonly mode: "html" | "plain";
  readonly html: string | null;
  readonly text: string;
}

export interface ComposeEditorProps {
  readonly initialHtml: string | null;
  readonly initialText: string;
  readonly onChange: (value: ComposeEditorValue) => void;
  readonly execCommand?: (command: string, value?: string) => boolean;
}

const COMMANDS = [
  ["Bold", "bold"],
  ["Italic", "italic"],
  ["Underline", "underline"],
  ["Bulleted list", "insertUnorderedList"],
  ["Numbered list", "insertOrderedList"],
] as const;

export function ComposeEditor(props: ComposeEditorProps): JSX.Element {
  const [mode, setMode] = createSignal<"html" | "plain">(
    props.initialHtml === null ? "plain" : "html",
  );
  const [plainText, setPlainText] = createSignal(props.initialText);
  const [html, setHtml] = createSignal(
    sanitizeComposeHtml(
      props.initialHtml ?? plainTextToHtml(props.initialText),
    ),
  );
  let editor: HTMLDivElement | undefined;
  onCleanup(() => {
    editor = undefined;
  });

  const command = (name: string, value?: string): boolean => {
    const executor =
      props.execCommand ??
      ((action: string, commandValue?: string) =>
        typeof document.execCommand === "function"
          ? document.execCommand(action, false, commandValue)
          : false);
    return executor(name, value);
  };

  const emitHtml = (): void => {
    if (mode() !== "html" || editor === undefined) return;
    const safeHtml = sanitizeComposeHtml(editor.innerHTML);
    setHtml(safeHtml);
    setPlainText(htmlToPlainText(safeHtml));
    props.onChange({
      mode: "html",
      html: safeHtml,
      text: htmlToPlainText(safeHtml),
    });
  };

  const restoreSelection = (range: Range | null): void => {
    if (range === null) return;
    const selection = window.getSelection();
    if (selection === null) return;
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const selectedRange = (): Range | null => {
    const selection = window.getSelection();
    return selection !== null && selection.rangeCount > 0
      ? selection.getRangeAt(0).cloneRange()
      : null;
  };

  const runCommand = (name: string, value?: string): void => {
    const range = selectedRange();
    restoreSelection(range);
    command(name, value);
    emitHtml();
  };

  const createLink = (): void => {
    const range = selectedRange();
    const url = window.prompt("Enter link URL");
    if (url === null || !isAllowedLinkUrl(url)) {
      restoreSelection(range);
      return;
    }
    restoreSelection(range);
    command("createLink", url.trim());
    emitHtml();
  };

  const clearFormatting = (): void => {
    const range = selectedRange();
    restoreSelection(range);
    command("removeFormat");
    command("unlink");
    emitHtml();
  };

  const toggleMode = (): void => {
    if (mode() === "html") {
      if (
        !window.confirm(
          "Switching to plain text will remove formatting. Continue?",
        )
      )
        return;
      const text =
        editor === undefined
          ? htmlToPlainText(html())
          : htmlToPlainText(sanitizeComposeHtml(editor.innerHTML));
      setPlainText(text);
      setMode("plain");
      editor = undefined;
      props.onChange({ mode: "plain", html: null, text });
      return;
    }
    const nextHtml = sanitizeComposeHtml(plainTextToHtml(plainText()));
    setHtml(nextHtml);
    setMode("html");
    props.onChange({
      mode: "html",
      html: nextHtml,
      text: htmlToPlainText(nextHtml),
    });
  };

  const onPaste: JSX.EventHandler<HTMLDivElement, ClipboardEvent> = (event) => {
    event.preventDefault();
    const clipboard = event.clipboardData;
    const pastedHtml = clipboard?.getData("text/html") ?? "";
    if (pastedHtml.length > 0) {
      command("insertHTML", sanitizeComposeHtml(pastedHtml));
    } else {
      command("insertText", clipboard?.getData("text/plain") ?? "");
    }
    emitHtml();
  };

  const onDrop: JSX.EventHandler<HTMLDivElement, DragEvent> = (event) => {
    event.preventDefault();
    const transfer = event.dataTransfer;
    const droppedHtml = transfer?.getData("text/html") ?? "";
    if (droppedHtml.length > 0) {
      command("insertHTML", sanitizeComposeHtml(droppedHtml));
    } else {
      command("insertText", transfer?.getData("text/plain") ?? "");
    }
    emitHtml();
  };

  return (
    <div class="compose-editor-wrap">
      <div
        class="compose-editor-toolbar"
        role="toolbar"
        aria-label="Formatting"
      >
        <Show when={mode() === "html"}>
          {COMMANDS.map(([label, name]) => (
            <button
              type="button"
              aria-label={label}
              onClick={() => runCommand(name)}
            >
              {label}
            </button>
          ))}
          <button type="button" aria-label="Link" onClick={createLink}>
            Link
          </button>
          <button
            type="button"
            aria-label="Blockquote"
            onClick={() => runCommand("formatBlock", "blockquote")}
          >
            Quote
          </button>
          <button
            type="button"
            aria-label="Clear formatting"
            onClick={clearFormatting}
          >
            Clear
          </button>
        </Show>
        <button
          type="button"
          aria-label={mode() === "html" ? "Use plain text" : "Use rich text"}
          onClick={toggleMode}
        >
          {mode() === "html" ? "Plain text" : "Rich text"}
        </button>
      </div>
      <Show
        when={mode() === "html"}
        fallback={
          <textarea
            class="compose-editor-plain"
            aria-label="Message"
            value={plainText()}
            onInput={(event) => {
              const text = event.currentTarget.value;
              setPlainText(text);
              props.onChange({ mode: "plain", html: null, text });
            }}
          />
        }
      >
        {/* biome-ignore lint/a11y/useSemanticElements: contenteditable provides the required rich-text editing surface. */}
        <div
          ref={(element) => {
            editor = element;
            element.innerHTML = html();
          }}
          class="compose-editor"
          contentEditable={true}
          tabIndex={0}
          role="textbox"
          aria-label="Message"
          aria-multiline="true"
          onInput={emitHtml}
          onPaste={onPaste}
          onDrop={onDrop}
        />
      </Show>
    </div>
  );
}
