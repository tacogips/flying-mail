import { createSignal, For, type JSX, Show } from "solid-js";
import { uploadAttachment } from "../api/graphql-client";
import type { SendMessageVariables } from "../api/schema-types";
import { describeErrors } from "../lib/mutation-error";
import { pushToast } from "../lib/toast";
import { CloseIcon, MinusIcon, PaperclipIcon, TrashIcon } from "./icons";
import "./compose-form.css";

export interface ComposeDraft {
  /** Present when editing a stored draft; Send then dispatches that draft
   * and Save updates it in place. */
  readonly draftId?: string;
  readonly from: string;
  readonly to: string;
  readonly cc: string;
  readonly subject: string;
  readonly text: string;
  readonly inReplyToMessageId?: string;
}

export interface ComposeContent {
  readonly draftId?: string;
  readonly inReplyToMessageId?: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
}

interface UploadedAttachment {
  readonly id: string;
  readonly fileName: string;
}

function splitAddresses(value: string): readonly string[] {
  return value
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function ComposeForm(props: {
  readonly draft: ComposeDraft;
  /** From the viewer's MAIL_SEND scopes, so the picker cannot offer a
   * sender the server will reject. */
  readonly sendableAddresses: readonly string[];
  readonly onCancel: () => void;
  readonly onSend: (input: SendMessageVariables) => Promise<boolean>;
  /** Saves the current content as a draft. Returns the draft id so later
   * saves in the same session update rather than duplicate. */
  readonly onSaveDraft?: (content: ComposeContent) => Promise<string | null>;
  /** Dispatches a stored draft after saving the latest edits. */
  readonly onSendDraft?: (content: ComposeContent) => Promise<boolean>;
}): JSX.Element {
  const [from, setFrom] = createSignal(props.draft.from);
  const [to, setTo] = createSignal(props.draft.to);
  const [cc, setCc] = createSignal(props.draft.cc);
  const [subject, setSubject] = createSignal(props.draft.subject);
  const [text, setText] = createSignal(props.draft.text);
  const [attachments, setAttachments] = createSignal<
    readonly UploadedAttachment[]
  >([]);
  const [sending, setSending] = createSignal(false);
  const [uploading, setUploading] = createSignal(false);
  const [savingDraft, setSavingDraft] = createSignal(false);
  const [draftId, setDraftId] = createSignal<string | null>(
    props.draft.draftId ?? null,
  );
  const [showCc, setShowCc] = createSignal(props.draft.cc.length > 0);
  const [minimized, setMinimized] = createSignal(false);
  let fileInputRef: HTMLInputElement | undefined;

  const title = () =>
    props.draft.inReplyToMessageId === undefined ? "New message" : "Reply";

  function currentContent(): ComposeContent {
    const id = draftId();
    return {
      ...(id === null ? {} : { draftId: id }),
      ...(props.draft.inReplyToMessageId === undefined
        ? {}
        : { inReplyToMessageId: props.draft.inReplyToMessageId }),
      from: from(),
      to: splitAddresses(to()),
      cc: splitAddresses(cc()),
      subject: subject(),
      text: text(),
      attachmentIds: attachments().map((entry) => entry.id),
    };
  }

  async function handleSaveDraft(): Promise<void> {
    if (props.onSaveDraft === undefined) {
      return;
    }
    setSavingDraft(true);
    const savedId = await props.onSaveDraft(currentContent());
    if (savedId !== null) {
      setDraftId(savedId);
    }
    setSavingDraft(false);
  }

  async function handleFiles(files: FileList | null): Promise<void> {
    if (files === null || files.length === 0) {
      return;
    }
    setUploading(true);
    for (const file of Array.from(files)) {
      const result = await uploadAttachment(file);
      if (!result.ok) {
        pushToast("error", describeErrors(result.errors));
        continue;
      }
      setAttachments((current) => [...current, result.data]);
    }
    setUploading(false);
  }

  async function handleSend(event: Event): Promise<void> {
    event.preventDefault();
    const recipients = splitAddresses(to());
    if (recipients.length === 0) {
      pushToast("error", "At least one recipient is required");
      return;
    }
    setSending(true);
    if (draftId() !== null && props.onSendDraft !== undefined) {
      const dispatched = await props.onSendDraft(currentContent());
      setSending(false);
      if (dispatched) {
        props.onCancel();
      }
      return;
    }
    const ccList = splitAddresses(cc());
    const attachmentIds = attachments().map((entry) => entry.id);
    const sent = await props.onSend({
      from: from(),
      to: recipients,
      subject: subject(),
      text: text(),
      ...(ccList.length > 0 ? { cc: ccList } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(props.draft.inReplyToMessageId === undefined
        ? {}
        : { inReplyToMessageId: props.draft.inReplyToMessageId }),
    });
    setSending(false);
    if (sent) {
      props.onCancel();
    }
  }

  function draftStatusLabel(): string {
    if (savingDraft()) {
      return "Saving...";
    }
    return draftId() !== null ? "Saved" : "Not saved";
  }

  return (
    <section class="compose-window">
      <div class="compose-titlebar">
        <span class="compose-titlebar-title">{title()}</span>
        <span class="compose-titlebar-spacer" />
        <button
          type="button"
          class="icon-button compose-titlebar-button"
          aria-label="Minimize"
          onClick={() => setMinimized((current) => !current)}
        >
          <MinusIcon />
        </button>
        <button
          type="button"
          class="icon-button compose-titlebar-button"
          aria-label="Close"
          onClick={() => props.onCancel()}
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
              <Show
                when={props.sendableAddresses.length > 0}
                fallback={
                  <p class="muted compose-no-sender">
                    No sender address is available to you. An administrator must
                    add and verify a domain, and grant you a MAIL_SEND scope.
                  </p>
                }
              >
                <select
                  id="compose-from"
                  class="compose-row-input"
                  value={from()}
                  onChange={(event) => setFrom(event.currentTarget.value)}
                >
                  <For each={props.sendableAddresses}>
                    {(address) => <option value={address}>{address}</option>}
                  </For>
                </select>
              </Show>
            </div>

            <div class="compose-row">
              <label for="compose-to" class="compose-row-label">
                To
              </label>
              <input
                id="compose-to"
                type="text"
                class="compose-row-input"
                autocomplete="off"
                placeholder="someone@example.com, other@example.com"
                value={to()}
                onInput={(event) => setTo(event.currentTarget.value)}
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
            </div>

            <Show when={showCc()}>
              <div class="compose-row">
                <label for="compose-cc" class="compose-row-label">
                  Cc
                </label>
                <input
                  id="compose-cc"
                  type="text"
                  class="compose-row-input"
                  autocomplete="off"
                  value={cc()}
                  onInput={(event) => setCc(event.currentTarget.value)}
                />
              </div>
            </Show>

            <div class="compose-row">
              <label for="compose-subject" class="compose-row-label">
                Subject
              </label>
              <input
                id="compose-subject"
                type="text"
                class="compose-row-input"
                value={subject()}
                onInput={(event) => setSubject(event.currentTarget.value)}
              />
            </div>

            <textarea
              id="compose-body"
              class="compose-body-text"
              aria-label="Message"
              value={text()}
              onInput={(event) => setText(event.currentTarget.value)}
            />

            <Show when={attachments().length > 0}>
              <ul class="compose-attachments">
                <For each={attachments()}>
                  {(attachment) => (
                    <li class="compose-attachment-chip">
                      <PaperclipIcon size={14} />
                      {attachment.fileName}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            class="compose-file-input"
            disabled={uploading()}
            onChange={(event) => void handleFiles(event.currentTarget.files)}
          />

          <div class="compose-footer">
            <button
              type="button"
              class="icon-button"
              aria-label="Discard draft"
              title="Discard draft"
              onClick={() => props.onCancel()}
            >
              <TrashIcon />
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label="Attach files"
              title="Attach files"
              disabled={uploading()}
              onClick={() => fileInputRef?.click()}
            >
              <PaperclipIcon />
            </button>
            <span class="compose-footer-spacer" />
            <span class="muted compose-draft-status">{draftStatusLabel()}</span>
            <Show when={props.onSaveDraft !== undefined}>
              <button
                type="button"
                disabled={savingDraft() || sending() || uploading()}
                onClick={() => void handleSaveDraft()}
              >
                {savingDraft() ? "Saving..." : "Save draft"}
              </button>
            </Show>
            <button
              type="submit"
              class="primary pill"
              disabled={
                sending() || uploading() || props.sendableAddresses.length === 0
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
