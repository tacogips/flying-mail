import {
  MAX_OUTBOUND_ATTACHMENTS,
  MAX_OUTBOUND_TOTAL_BYTES,
  MAX_RECIPIENTS_PER_MESSAGE,
} from "./send";

export { MAX_IDS_PER_REQUEST } from "./id-limits";

/** Largest `max` an external fetch run accepts. */
export const MAX_EXTERNAL_FETCH_PER_RUN = 200;

export const MAX_ATTACHMENT_UPLOAD_BYTES = 5 * 1024 * 1024;

export interface MailLimits {
  readonly maxAttachmentBytes: number;
  readonly maxOutboundTotalBytes: number;
  readonly maxAttachmentsPerMessage: number;
  readonly maxRecipientsPerMessage: number;
}

export function getMailLimits(): MailLimits {
  return {
    maxAttachmentBytes: MAX_ATTACHMENT_UPLOAD_BYTES,
    maxOutboundTotalBytes: MAX_OUTBOUND_TOTAL_BYTES,
    maxAttachmentsPerMessage: MAX_OUTBOUND_ATTACHMENTS,
    maxRecipientsPerMessage: MAX_RECIPIENTS_PER_MESSAGE,
  };
}
