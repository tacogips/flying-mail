import { createSignal, type JSX } from "solid-js";
import { graphqlRequest } from "../api/graphql-client";
import { CREATE_ATTACHMENT_LINK_MUTATION } from "../api/documents";
import type { AttachmentView, CreatedFileLinkView } from "../api/schema-types";
import { describeErrors } from "../lib/mutation-error";
import { formatBytes } from "../lib/relative-time";
import { pushToast } from "../lib/toast";
import "./attachment-tile.css";

const LINK_TTL_SECONDS = 3600;

export function AttachmentTile(props: {
  readonly attachment: AttachmentView;
}): JSX.Element {
  const [minting, setMinting] = createSignal(false);
  const [link, setLink] = createSignal<string | null>(null);

  async function mintLink(): Promise<void> {
    setMinting(true);
    const result = await graphqlRequest<
      { readonly createAttachmentLink: CreatedFileLinkView },
      Record<string, unknown>
    >(CREATE_ATTACHMENT_LINK_MUTATION, {
      attachmentId: props.attachment.id,
      ttlSeconds: LINK_TTL_SECONDS,
    });
    setMinting(false);
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    const url = result.data.createAttachmentLink.url;
    setLink(url);
    // Best-effort: a clipboard write can be denied, and the URL is shown
    // inline anyway so the reader is never stuck.
    void navigator.clipboard?.writeText(url).then(
      () => pushToast("success", "Temporary link copied (expires in 1 hour)"),
      () => pushToast("info", "Temporary link created"),
    );
  }

  return (
    <div class="attachment-tile">
      <div class="attachment-meta">
        <a
          class="attachment-name"
          href={props.attachment.url}
          download={props.attachment.fileName}
        >
          {props.attachment.fileName}
        </a>
        <span class="muted">
          {props.attachment.contentType} - {formatBytes(props.attachment.size)}
        </span>
      </div>
      <button
        type="button"
        disabled={minting()}
        onClick={() => void mintLink()}
      >
        {minting() ? "Creating..." : "Copy temp link"}
      </button>
      {link() !== null ? <code class="attachment-link">{link()}</code> : null}
    </div>
  );
}
