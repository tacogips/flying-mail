export type ComposeRequest =
  | { readonly kind: "NEW" }
  | {
      readonly kind: "REPLY" | "REPLY_ALL" | "FORWARD";
      readonly messageId: string;
    }
  | { readonly kind: "DRAFT"; readonly messageId: string };

export type ComposeAttachmentOrigin = "upload" | "forward" | "draft";

export interface ComposeAttachmentChip {
  readonly localKey: string;
  readonly id: string | null;
  readonly fileName: string;
  readonly size: number;
  readonly contentType: string;
  readonly origin: ComposeAttachmentOrigin;
  readonly status: "uploading" | "done" | "error";
  readonly progress: number;
  readonly error?: string;
  readonly sourceAttachmentId?: string;
}

export interface ComposeInitialState {
  readonly title: "New message" | "Reply" | "Forward";
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
  readonly attachments: readonly ComposeAttachmentChip[];
}

export interface ComposeHostProps {
  readonly request: ComposeRequest | null;
  readonly scope: { readonly domainId?: string; readonly address?: string };
  readonly onClose: () => void;
  readonly onMailboxChanged: () => void;
}
