import { createEffect, createSignal, Show, untrack, type JSX } from "solid-js";
import { MESSAGE_QUERY } from "../api/documents";
import { graphqlRequest } from "../api/graphql-client";
import type {
  AttachmentView,
  MessageDetailView,
  SendMessageVariables,
} from "../api/schema-types";
import { plainTextToHtml, sanitizeComposeHtml } from "../lib/compose-html";
import {
  activeSendableAddresses,
  defaultFromForScope,
} from "../lib/domain-rail";
import type {
  ComposeAttachmentChip,
  ComposeHostProps,
  ComposeInitialState,
} from "../lib/compose-types";
import {
  ComposeForm,
  type ComposeSaveResult,
  type ComposeSubmit,
} from "./compose-form";
import { useStore } from "../store/store-context";

function attachmentChip(
  attachment: AttachmentView,
  origin: "draft" | "forward",
): ComposeAttachmentChip {
  return {
    localKey: `${origin}-${attachment.id}`,
    id: origin === "forward" ? null : attachment.id,
    fileName: attachment.fileName,
    size: attachment.size,
    contentType: attachment.contentType,
    origin,
    status: "done",
    progress: 100,
    ...(origin === "forward" ? { sourceAttachmentId: attachment.id } : {}),
  };
}

export function ComposeHost(props: ComposeHostProps): JSX.Element {
  const store = useStore();
  const [initial, setInitial] = createSignal<ComposeInitialState | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal("");
  let loadSequence = 0;
  let openDraftId: string | null = null;
  let createdDraftId: string | null = null;

  createEffect(() => {
    const request = props.request;
    if (request?.kind === "DRAFT" && request.messageId === openDraftId) {
      return;
    }
    const sequence = ++loadSequence;
    openDraftId = null;
    setInitial(null);
    setLoadError("");
    if (request === null) {
      setLoading(false);
      return;
    }
    if (request.kind === "NEW") {
      setLoading(false);
      const viewer = untrack(() => store.viewer());
      const domains = untrack(() => store.domains());
      const address = defaultFromForScope(
        viewer?.sendableAddresses ?? [],
        domains,
        props.scope,
      );
      setInitial({
        title: "New message",
        draftId: null,
        from: address,
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
      });
      return;
    }
    setLoading(true);
    void (async () => {
      if (
        request.kind === "REPLY" ||
        request.kind === "REPLY_ALL" ||
        request.kind === "FORWARD"
      ) {
        const prefill = await store.composeFromMessage(
          request.messageId,
          request.kind,
        );
        if (sequence !== loadSequence) return;
        if (prefill === null) {
          setLoadError("Could not load the message to compose from.");
          setLoading(false);
          return;
        }
        const forwarding = request.kind === "FORWARD";
        setInitial({
          title: forwarding ? "Forward" : "Reply",
          draftId: null,
          from:
            prefill.from ??
            store
              .viewer()
              ?.sendableAddresses.find((entry) => !entry.includes("*")) ??
            "",
          replyTo: null,
          to: prefill.to,
          cc: prefill.cc,
          bcc: [],
          subject: prefill.subject,
          html: sanitizeComposeHtml(
            prefill.quotedHtml ?? plainTextToHtml(prefill.quotedText),
          ),
          text: prefill.quotedText,
          inReplyToMessageId: prefill.inReplyToMessageId,
          forwardedFromMessageId: prefill.forwardedFromMessageId,
          attachments: forwarding
            ? prefill.forwardAttachments.map((attachment) =>
                attachmentChip(attachment, "forward"),
              )
            : [],
        });
        setLoading(false);
        return;
      }
      const result = await graphqlRequest<
        { readonly message: MessageDetailView | null },
        { readonly id: string }
      >(MESSAGE_QUERY, { id: request.messageId });
      if (sequence !== loadSequence) return;
      if (!result.ok || result.data.message === null) {
        setLoadError("Could not reopen this draft.");
        setLoading(false);
        return;
      }
      const message = result.data.message;
      openDraftId = message.id;
      const kind =
        message.inReplyTo !== null
          ? "Reply"
          : message.forwardedFromMessageId !== null
            ? "Forward"
            : "New message";
      setInitial({
        title: kind,
        draftId: message.id,
        from: message.from.address,
        replyTo: message.replyTo,
        to: message.recipients
          .filter((recipient) => recipient.kind === "TO")
          .map((recipient) => recipient.address),
        cc: message.recipients
          .filter((recipient) => recipient.kind === "CC")
          .map((recipient) => recipient.address),
        bcc: message.recipients
          .filter((recipient) => recipient.kind === "BCC")
          .map((recipient) => recipient.address),
        subject: message.subject,
        html:
          message.htmlBody === null
            ? null
            : sanitizeComposeHtml(message.htmlBody),
        text: message.textBody ?? "",
        inReplyToMessageId: null,
        forwardedFromMessageId: null,
        attachments: message.attachments.map((attachment) =>
          attachmentChip(attachment, "draft"),
        ),
      });
      setLoading(false);
    })().catch(() => {
      if (sequence !== loadSequence) return;
      setLoadError("Could not load the compose details.");
      setLoading(false);
    });
  });

  const save = async (content: ComposeSubmit): Promise<ComposeSaveResult> => {
    const input = {
      ...(content.draftId === null ? {} : { draftId: content.draftId }),
      ...(content.draftId === null && content.inReplyToMessageId !== null
        ? { inReplyToMessageId: content.inReplyToMessageId }
        : {}),
      ...((content.draftId === null ||
        content.forwardAttachmentIds.length > 0) &&
      content.forwardedFromMessageId !== null
        ? { forwardedFromMessageId: content.forwardedFromMessageId }
        : {}),
      from: content.from,
      ...(content.replyTo === null ? {} : { replyTo: content.replyTo }),
      to: content.to,
      cc: content.cc,
      bcc: content.bcc,
      subject: content.subject,
      text: content.text,
      ...(content.html === null
        ? {}
        : { html: sanitizeComposeHtml(content.html) }),
      attachmentIds: content.attachmentIds,
      forwardAttachmentIds: content.forwardAttachmentIds,
    };
    const result = await store.saveDraftDetailed(input, { silent: true });
    if (result.kind !== "saved") return result;
    const id = result.draft.id;
    if (content.draftId === null && createdDraftId !== id) {
      createdDraftId = id;
      props.onMailboxChanged();
    }
    return {
      kind: "saved",
      draftId: id,
      attachments: result.draft.attachments,
    };
  };

  const send = async (content: ComposeSubmit): Promise<"sent" | "failed"> => {
    let sent: boolean;
    if (content.draftId !== null) {
      const result = await store.saveDraftDetailed({
        draftId: content.draftId,
        from: content.from,
        ...(content.replyTo === null ? {} : { replyTo: content.replyTo }),
        to: content.to,
        cc: content.cc,
        bcc: content.bcc,
        ...(content.forwardAttachmentIds.length > 0 &&
        content.forwardedFromMessageId !== null
          ? { forwardedFromMessageId: content.forwardedFromMessageId }
          : {}),
        subject: content.subject,
        text: content.text,
        ...(content.html === null
          ? {}
          : { html: sanitizeComposeHtml(content.html) }),
        attachmentIds: content.attachmentIds,
        forwardAttachmentIds: content.forwardAttachmentIds,
      });
      if (result.kind !== "saved") return "failed";
      sent = await store.sendDraft(content.draftId);
    } else {
      const input: SendMessageVariables = {
        from: content.from,
        to: content.to,
        cc: content.cc,
        bcc: content.bcc,
        subject: content.subject,
        text: content.text,
        ...(content.html === null
          ? {}
          : { html: sanitizeComposeHtml(content.html) }),
        ...(content.replyTo === null ? {} : { replyTo: content.replyTo }),
        ...(content.inReplyToMessageId === null
          ? {}
          : { inReplyToMessageId: content.inReplyToMessageId }),
        ...(content.forwardedFromMessageId === null
          ? {}
          : { forwardedFromMessageId: content.forwardedFromMessageId }),
        attachmentIds: content.attachmentIds,
        forwardAttachmentIds: content.forwardAttachmentIds,
      };
      sent = await store.send(input);
    }
    if (!sent) return "failed";
    props.onMailboxChanged();
    return "sent";
  };

  const discard = async (draftId: string | null): Promise<void> => {
    if (draftId !== null) {
      const deleted = await store.deleteDraft(draftId);
      if (deleted) props.onMailboxChanged();
    }
    props.onClose();
  };

  return (
    <Show when={props.request !== null}>
      <Show
        when={initial()}
        fallback={
          <Show when={loading() || loadError().length > 0}>
            <section class="compose-window" role="status">
              {loadError() || "Loading message..."}
            </section>
          </Show>
        }
      >
        {(value) => (
          <ComposeForm
            initial={value()}
            sendableAddresses={activeSendableAddresses(
              store.viewer()?.sendableAddresses ?? [],
              store.domains(),
            )}
            limits={store.mailLimits()}
            onSend={send}
            onSave={save}
            onDiscard={discard}
            onClose={props.onClose}
          />
        )}
      </Show>
    </Show>
  );
}
