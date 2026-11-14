import { createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import type { AttachmentView, MailLimitsView } from "../api/schema-types";
import { createDraftSaver, type DraftSaverState } from "../lib/draft-autosave";
import { htmlToPlainText, sanitizeComposeHtml } from "../lib/compose-html";
import {
  mapWithConcurrency,
  uploadAttachmentWithProgress,
} from "../lib/upload";
import type {
  ComposeAttachmentChip,
  ComposeInitialState,
} from "../lib/compose-types";
import { addressDomain, addressMatchesPattern } from "../lib/domain-rail";
import { CloseIcon, MinusIcon, PaperclipIcon, TrashIcon } from "./icons";
import { ComposeAttachments } from "./compose-attachments";
import { ComposeEditor, type ComposeEditorValue } from "./compose-editor";
import "./compose-form.css";

export interface ComposeSubmit {
  readonly draftId: string | null;
  readonly from: string;
  readonly replyTo: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly html: string | null;
  readonly text: string;
  readonly inReplyToMessageId: string | null;
  readonly forwardedFromMessageId: string | null;
  readonly attachmentIds: readonly string[];
  readonly forwardAttachmentIds: readonly string[];
}

export type ComposeSaveResult =
  | {
      readonly kind: "saved";
      readonly draftId?: string;
      readonly attachments?: readonly AttachmentView[];
    }
  | { readonly kind: "conflict" }
  | { readonly kind: "error"; readonly message: string };

export interface ComposeFormProps {
  readonly initial: ComposeInitialState;
  readonly sendableAddresses: readonly string[];
  readonly limits: MailLimitsView | null;
  readonly onSend: (content: ComposeSubmit) => Promise<"sent" | "failed">;
  readonly onSave: (content: ComposeSubmit) => Promise<ComposeSaveResult>;
  readonly onDiscard: (draftId: string | null) => Promise<void>;
  readonly onClose: () => void;
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024;

export function splitAddresses(value: string): readonly string[] {
  return value
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function sameContent(left: ComposeSubmit, right: ComposeSubmit): boolean {
  const { draftId: _leftDraftId, ...leftContent } = left;
  const { draftId: _rightDraftId, ...rightContent } = right;
  return JSON.stringify(leftContent) === JSON.stringify(rightContent);
}

function makeKey(): string {
  return crypto.randomUUID();
}

export function ComposeForm(props: ComposeFormProps): JSX.Element {
  const initialPattern =
    props.sendableAddresses.find(
      (address) =>
        address.includes("*") &&
        addressMatchesPattern(address, props.initial.from),
    ) ?? null;
  const [fromChoice, setFromChoice] = createSignal(
    props.sendableAddresses.includes(props.initial.from)
      ? props.initial.from
      : (initialPattern ?? props.initial.from),
  );
  const [localPart, setLocalPart] = createSignal(
    initialPattern === null || props.initial.from.includes("*")
      ? ""
      : (props.initial.from.split("@")[0] ?? ""),
  );
  const [to, setTo] = createSignal(props.initial.to.join(", "));
  const [cc, setCc] = createSignal(props.initial.cc.join(", "));
  const [bcc, setBcc] = createSignal(props.initial.bcc.join(", "));
  const [subject, setSubject] = createSignal(props.initial.subject);
  const [body, setBody] = createSignal<ComposeEditorValue>({
    mode: props.initial.html === null ? "plain" : "html",
    html: props.initial.html,
    text: props.initial.text,
  });
  const [chips, setChips] = createSignal<readonly ComposeAttachmentChip[]>(
    props.initial.attachments,
  );
  const [draftId, setDraftId] = createSignal(props.initial.draftId);
  const [showCc, setShowCc] = createSignal(props.initial.cc.length > 0);
  const [showBcc, setShowBcc] = createSignal(props.initial.bcc.length > 0);
  const [sending, setSending] = createSignal(false);
  const [minimized, setMinimized] = createSignal(false);
  const [saverState, setSaverState] = createSignal<DraftSaverState>("idle");
  const [sendError, setSendError] = createSignal("");
  const [closeSaveError, setCloseSaveError] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;
  const maxFileBytes = () =>
    props.limits?.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const maxTotalBytes = () =>
    props.limits?.maxOutboundTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const selectedPattern = () =>
    fromChoice().includes("*") ? fromChoice() : null;
  const from = () => {
    const pattern = selectedPattern();
    return pattern === null
      ? fromChoice()
      : `${localPart()}@${pattern.split("@").at(-1) ?? ""}`;
  };
  const fromIsValid = () => {
    const pattern = selectedPattern();
    return (
      pattern === null ||
      (localPart().length > 0 && addressMatchesPattern(pattern, from()))
    );
  };
  const addressesByDomain = () => {
    const grouped = new Map<string, string[]>();
    for (const address of props.sendableAddresses) {
      const domain = addressDomain(address);
      grouped.set(domain, [...(grouped.get(domain) ?? []), address]);
    }
    return Array.from(grouped, ([domain, addresses]) => ({
      domain,
      addresses,
    }));
  };
  const totalBytes = () =>
    chips()
      .filter((chip) => chip.status !== "error")
      .reduce((sum, chip) => sum + chip.size, 0);
  const busyUploading = () =>
    chips().some((chip) => chip.status === "uploading");
  const recipients = () => splitAddresses(to());
  const recipientsAreValid = () =>
    [to(), cc(), bcc()]
      .flatMap(splitAddresses)
      .every((address) => /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(address));
  const formContent = (): ComposeSubmit => {
    const currentChips = chips();
    const safeHtml =
      body().mode === "html" ? sanitizeComposeHtml(body().html ?? "") : null;
    return {
      draftId: draftId(),
      from: from(),
      replyTo: props.initial.replyTo,
      to: recipients(),
      cc: splitAddresses(cc()),
      bcc: splitAddresses(bcc()),
      subject: subject(),
      html: safeHtml,
      text: safeHtml === null ? body().text : htmlToPlainText(safeHtml),
      inReplyToMessageId: props.initial.inReplyToMessageId,
      forwardedFromMessageId: props.initial.forwardedFromMessageId,
      attachmentIds: currentChips
        .filter((chip) => chip.status === "done" && chip.id !== null)
        .map((chip) => chip.id as string),
      forwardAttachmentIds: currentChips
        .filter(
          (chip) =>
            chip.origin === "forward" &&
            chip.id === null &&
            chip.sourceAttachmentId !== undefined,
        )
        .map((chip) => chip.sourceAttachmentId as string),
    };
  };
  const saver = createDraftSaver<ComposeSubmit>({
    debounceMs: 2000,
    save: async (_content) => {
      const content = formContent();
      const result = await props.onSave(content);
      if (result.kind === "saved") {
        if (result.draftId !== undefined) setDraftId(result.draftId);
        if (result.attachments !== undefined) {
          setChips((current) => {
            const claimedIds = new Set(
              current.flatMap((chip) => (chip.id === null ? [] : [chip.id])),
            );
            return current.map((chip) => {
              if (chip.origin !== "forward" || chip.id !== null) return chip;
              const adopted = result.attachments?.find(
                (attachment) =>
                  !claimedIds.has(attachment.id) &&
                  attachment.fileName === chip.fileName &&
                  attachment.size === chip.size,
              );
              if (adopted !== undefined) claimedIds.add(adopted.id);
              return adopted === undefined
                ? chip
                : { ...chip, id: adopted.id, status: "done" };
            });
          });
        }
        return { kind: "saved" };
      }
      return result;
    },
    isSame: sameContent,
    onStateChange: setSaverState,
  });
  onCleanup(() => {
    void saver.flush();
  });

  const notifyChanged = (): void => {
    if (!fromIsValid() || !recipientsAreValid() || sending()) return;
    setCloseSaveError(false);
    saver.notifyChange(formContent());
  };

  const uploadFiles = async (fileList: FileList | null): Promise<void> => {
    if (fileList === null || fileList.length === 0) return;
    const files = Array.from(fileList);
    const pending = files.map((file) => ({ file, key: makeKey() }));
    setChips((current) => [
      ...current,
      ...pending.map(({ file, key }) => ({
        localKey: key,
        id: null,
        fileName: file.name,
        size: file.size,
        contentType: file.type || "application/octet-stream",
        origin: "upload" as const,
        status:
          file.size > maxFileBytes()
            ? ("error" as const)
            : ("uploading" as const),
        progress: 0,
        ...(file.size > maxFileBytes()
          ? { error: `File exceeds ${maxFileBytes()} bytes.` }
          : {}),
      })),
    ]);
    notifyChanged();
    const accepted = pending.filter(({ file }) => file.size <= maxFileBytes());
    await mapWithConcurrency(accepted, 3, async ({ file, key }) => {
      const request = uploadAttachmentWithProgress(file, (loaded, total) => {
        setChips((current) =>
          current.map((chip) =>
            chip.localKey === key
              ? {
                  ...chip,
                  progress: total > 0 ? Math.round((loaded / total) * 100) : 0,
                }
              : chip,
          ),
        );
      });
      uploadRequests.set(key, request);
      if (!chips().some((chip) => chip.localKey === key)) {
        request.abort();
        uploadRequests.delete(key);
        return;
      }
      const result = await request.promise;
      if (uploadRequests.get(key) === request) uploadRequests.delete(key);
      setChips((current) =>
        current.map((chip) => {
          if (chip.localKey !== key) return chip;
          return result.ok
            ? {
                ...chip,
                id: result.attachment.id,
                fileName: result.attachment.fileName,
                contentType: result.attachment.contentType,
                size: result.attachment.size,
                status: "done",
                progress: 100,
              }
            : {
                ...chip,
                status: "error",
                error:
                  result.failure === "TOO_LARGE"
                    ? `${result.message}${result.maxBytes === undefined ? "" : ` Maximum ${result.maxBytes} bytes.`}`
                    : result.message,
              };
        }),
      );
      notifyChanged();
    });
    notifyChanged();
  };

  const uploadRequests = new Map<
    string,
    ReturnType<typeof uploadAttachmentWithProgress>
  >();

  const removeChip = (localKey: string): void => {
    uploadRequests.get(localKey)?.abort();
    uploadRequests.delete(localKey);
    setChips((current) => current.filter((chip) => chip.localKey !== localKey));
    notifyChanged();
  };

  const handleSend = async (event: Event): Promise<void> => {
    event.preventDefault();
    if (
      sending() ||
      recipients().length === 0 ||
      !fromIsValid() ||
      busyUploading() ||
      totalBytes() > maxTotalBytes()
    )
      return;
    setSending(true);
    setSendError("");
    await saver.cancel();
    const result = await props.onSend(formContent());
    if (result === "sent") {
      saver.dispose();
      props.onClose();
      return;
    }
    setSending(false);
    setSendError("Message could not be sent. Try again.");
  };

  const handleDiscard = async (): Promise<void> => {
    if (!window.confirm("Discard this message?")) return;
    await saver.cancel();
    await props.onDiscard(draftId());
    saver.dispose();
  };

  const handleClose = async (): Promise<void> => {
    await saver.flush();
    if (saver.state() === "error" || !recipientsAreValid()) {
      setCloseSaveError(true);
      return;
    }
    props.onClose();
  };

  const handleRetrySave = async (): Promise<void> => {
    if (!recipientsAreValid()) return;
    setCloseSaveError(false);
    saver.notifyChange(formContent());
    await saver.flush();
  };

  const statusLabel = (): string => {
    switch (saverState()) {
      case "pending":
      case "saving":
        return "Saving";
      case "saved":
        return "Saved";
      case "conflict":
        return "Conflict";
      case "error":
        return "Not saved";
      default:
        return draftId() === null ? "Not saved" : "Saved";
    }
  };

  return (
    <section class="compose-window">
      <div class="compose-titlebar">
        <span class="compose-titlebar-title">{props.initial.title}</span>
        <span class="compose-titlebar-spacer" />
        <button
          type="button"
          class="icon-button compose-titlebar-button"
          aria-label="Minimize"
          onClick={() => setMinimized((value) => !value)}
        >
          <MinusIcon />
        </button>
        <button
          type="button"
          class="icon-button compose-titlebar-button"
          aria-label="Close"
          onClick={() => void handleClose()}
        >
          <CloseIcon />
        </button>
      </div>
      <Show when={!minimized()}>
        <form class="compose-form" onSubmit={(event) => void handleSend(event)}>
          <div class="compose-body">
            <div class="compose-row">
              <label for="compose-from" class="compose-row-label">
                From
              </label>
              <select
                id="compose-from"
                class="compose-row-input"
                value={fromChoice()}
                onChange={(event) => {
                  setFromChoice(event.currentTarget.value);
                  notifyChanged();
                }}
              >
                <For each={addressesByDomain()}>
                  {(group) => (
                    <optgroup label={group.domain}>
                      <For each={group.addresses}>
                        {(address) => (
                          <option value={address}>
                            {address.includes("*")
                              ? `Other address on ${group.domain}`
                              : address}
                          </option>
                        )}
                      </For>
                    </optgroup>
                  )}
                </For>
              </select>
            </div>
            <Show when={selectedPattern() !== null}>
              <div class="compose-row compose-from-pattern">
                <label for="compose-from-local" class="compose-row-label">
                  Address
                </label>
                <input
                  id="compose-from-local"
                  class="compose-row-input"
                  aria-label="Local part"
                  value={localPart()}
                  onInput={(event) => {
                    setLocalPart(event.currentTarget.value);
                    notifyChanged();
                  }}
                />
              </div>
              <Show when={!fromIsValid()}>
                <p class="compose-field-error" role="alert">
                  Enter a local part that matches the sender pattern.
                </p>
              </Show>
            </Show>
            <div class="compose-row">
              <label for="compose-to" class="compose-row-label">
                To
              </label>
              <input
                id="compose-to"
                class="compose-row-input"
                value={to()}
                autocomplete="off"
                onInput={(event) => {
                  setTo(event.currentTarget.value);
                  notifyChanged();
                }}
              />
              <Show when={!showCc()}>
                <button
                  type="button"
                  class="compose-row-toggle"
                  onClick={() => setShowCc(true)}
                >
                  Cc
                </button>
              </Show>
              <Show when={!showBcc()}>
                <button
                  type="button"
                  class="compose-row-toggle"
                  onClick={() => setShowBcc(true)}
                >
                  Bcc
                </button>
              </Show>
            </div>
            <Show when={showCc()}>
              <div class="compose-row">
                <label for="compose-cc" class="compose-row-label">
                  Cc
                </label>
                <input
                  id="compose-cc"
                  class="compose-row-input"
                  value={cc()}
                  onInput={(event) => {
                    setCc(event.currentTarget.value);
                    notifyChanged();
                  }}
                />
              </div>
            </Show>
            <Show when={showBcc()}>
              <div class="compose-row">
                <label for="compose-bcc" class="compose-row-label">
                  Bcc
                </label>
                <input
                  id="compose-bcc"
                  class="compose-row-input"
                  value={bcc()}
                  onInput={(event) => {
                    setBcc(event.currentTarget.value);
                    notifyChanged();
                  }}
                />
              </div>
            </Show>
            <div class="compose-row">
              <label for="compose-subject" class="compose-row-label">
                Subject
              </label>
              <input
                id="compose-subject"
                class="compose-row-input"
                value={subject()}
                onInput={(event) => {
                  setSubject(event.currentTarget.value);
                  notifyChanged();
                }}
              />
            </div>
            <ComposeEditor
              initialHtml={props.initial.html}
              initialText={props.initial.text}
              onChange={(value) => {
                setBody(value);
                notifyChanged();
              }}
            />
            <ComposeAttachments
              chips={chips()}
              onRemove={removeChip}
              totalBytes={totalBytes()}
              maxTotalBytes={maxTotalBytes()}
            />
            <Show when={recipients().length === 0}>
              <p class="compose-field-error" role="alert">
                Add at least one recipient to send.
              </p>
            </Show>
            <Show when={totalBytes() > maxTotalBytes()}>
              <p class="compose-field-error" role="alert">
                Attachments exceed the total message limit.
              </p>
            </Show>
            <Show when={sendError().length > 0}>
              <p class="compose-field-error" role="alert">
                {sendError()}
              </p>
            </Show>
            <Show when={saverState() === "conflict"}>
              <p class="compose-field-error" role="alert">
                This draft was sent or deleted elsewhere
              </p>
            </Show>
            <Show when={saverState() === "error" || closeSaveError()}>
              <div class="compose-field-error" role="alert">
                <span>Not saved</span>
                <button
                  type="button"
                  disabled={!recipientsAreValid()}
                  onClick={() => void handleRetrySave()}
                >
                  Retry
                </button>
                <button type="button" onClick={() => void handleDiscard()}>
                  Discard
                </button>
              </div>
            </Show>
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            class="compose-file-input"
            onChange={(event) => {
              void uploadFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <div class="compose-footer">
            <button
              type="button"
              class="icon-button"
              aria-label="Discard draft"
              title="Discard draft"
              onClick={() => void handleDiscard()}
            >
              <TrashIcon />
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label="Attach files"
              title="Attach files"
              onClick={() => fileInput?.click()}
            >
              <PaperclipIcon />
            </button>
            <span class="compose-footer-spacer" />
            <span class="muted compose-draft-status" aria-live="polite">
              {statusLabel()}
            </span>
            <button
              type="submit"
              class="primary pill"
              disabled={
                sending() ||
                busyUploading() ||
                totalBytes() > maxTotalBytes() ||
                recipients().length === 0 ||
                !fromIsValid() ||
                props.sendableAddresses.length === 0 ||
                saverState() === "conflict"
              }
            >
              {sending() ? "Sending..." : "Send"}
            </button>
          </div>
        </form>
      </Show>
    </section>
  );
}
