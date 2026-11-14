import { createMemo, createResource, createSignal, type JSX } from "solid-js";
import type { AttachmentView } from "../api/schema-types";
import {
  buildMailFrameDocument,
  hasBlockedImages,
  normalizeContentId,
  sanitizeMailHtml,
} from "../lib/mail-html";
import "./html-body-frame.css";

const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const MIN_FRAME_HEIGHT_PX = 120;
/** Upper bound on the auto-sized frame. A message declaring a huge height
 * would otherwise make the reading pane unusably tall; past this the frame
 * scrolls internally. */
export const MAX_FRAME_HEIGHT_PX = 30000;
const EMPTY_INLINE_IMAGES: ReadonlyMap<string, string> = new Map();

function isInlineImageCandidate(attachment: AttachmentView): boolean {
  return (
    attachment.contentId !== null &&
    attachment.contentType.startsWith("image/") &&
    attachment.size <= MAX_INLINE_IMAGE_BYTES
  );
}

function bytesToDataUri(bytes: Uint8Array, contentType: string): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

/** Fetches one attachment's bytes and pairs them with its normalized
 * content ID. Failures (network error, non-OK response) resolve to `null`
 * rather than throwing: an unresolved inline image simply stays
 * unresolved, with no toast -- it is not worth interrupting the reader
 * over a missing thumbnail in a newsletter. */
async function fetchInlineImage(
  attachment: AttachmentView,
): Promise<readonly [string, string] | null> {
  if (attachment.contentId === null) {
    return null;
  }
  let response: Response;
  try {
    response = await fetch(attachment.url);
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const dataUri = bytesToDataUri(bytes, attachment.contentType);
  return [normalizeContentId(attachment.contentId), dataUri];
}

async function loadInlineImages(
  attachments: readonly AttachmentView[],
): Promise<ReadonlyMap<string, string>> {
  const candidates = attachments.filter(isInlineImageCandidate);
  if (candidates.length === 0) {
    return EMPTY_INLINE_IMAGES;
  }
  const resolved = await Promise.all(candidates.map(fetchInlineImage));
  const map = new Map<string, string>();
  for (const entry of resolved) {
    if (entry !== null) {
      map.set(entry[0], entry[1]);
    }
  }
  return map;
}

/**
 * Renders an HTML mail body.
 *
 * The security posture here is deliberately belt-and-braces, because mail
 * bodies are attacker-controlled:
 *
 * 1. `sanitizeMailHtml` strips scripting constructs and dangerous URLs.
 * 2. The result is rendered in a sandboxed iframe. The sandbox grants
 *    `allow-same-origin` -- solely so this component can measure the
 *    frame's content height and auto-size it -- but withholds
 *    `allow-scripts`, so even a sanitizer bypass gets no script execution.
 *    Without script execution, the frame content has no way to reach this
 *    document's DOM, cookies, or storage, no matter what origin it runs at.
 * 3. `srcdoc` (rather than a blob URL) keeps the frame off any real
 *    network-addressable origin.
 * 4. The document itself carries a restrictive CSP meta tag.
 *
 * Remote images start blocked. That is a privacy measure rather than an XSS
 * one: loading them on open is what tells a sender the mail was read.
 *
 * Inline (`cid:`) images referenced by the body are resolved from
 * `attachments`: each matching attachment's same-origin URL is fetched and
 * base64-encoded client-side, and the resulting `data:` URIs are fed into
 * `sanitizeMailHtml`. Attachments over 5 MiB, or without a matching
 * `contentId` and an `image/*` content type, are skipped.
 */
/** Clamps a measured content height to the frame's allowed range. */
export function clampFrameHeight(measured: number): number {
  return Math.min(MAX_FRAME_HEIGHT_PX, Math.max(MIN_FRAME_HEIGHT_PX, measured));
}

export function HtmlBodyFrame(props: {
  readonly html: string;
  readonly messageId?: string;
  readonly title?: string;
  readonly attachments?: readonly AttachmentView[];
}): JSX.Element {
  const [imageConsent, setImageConsent] = createSignal<string | null>(null);
  const messageIdentity = (): string => props.messageId ?? props.html;
  const loadRemoteImages = (): boolean => imageConsent() === messageIdentity();
  const [frameHeight, setFrameHeight] = createSignal(MIN_FRAME_HEIGHT_PX);
  let iframeRef: HTMLIFrameElement | undefined;

  const [inlineImages] = createResource(
    () => props.attachments ?? [],
    loadInlineImages,
  );

  const sanitized = createMemo(() =>
    sanitizeMailHtml(props.html, {
      loadRemoteImages: loadRemoteImages(),
      inlineImages: inlineImages() ?? EMPTY_INLINE_IMAGES,
    }),
  );
  const blocked = createMemo(
    () => !loadRemoteImages() && hasBlockedImages(sanitized()),
  );
  const frameDocument = createMemo(() =>
    buildMailFrameDocument(sanitized(), loadRemoteImages()),
  );

  function measureFrameHeight(): void {
    try {
      const measured = iframeRef?.contentDocument?.documentElement.scrollHeight;
      if (measured !== undefined && measured > 0) {
        setFrameHeight(clampFrameHeight(measured));
      }
    } catch {
      // Cross-origin or already-detached frame: keep the current height.
    }
  }

  function handleFrameLoad(): void {
    measureFrameHeight();
    // Images fetched by the frame arrive after `load`; re-measure as each
    // one resolves so the frame grows to fit rather than clipping.
    const doc = iframeRef?.contentDocument;
    if (doc === null || doc === undefined) {
      return;
    }
    for (const img of doc.querySelectorAll("img")) {
      img.addEventListener("load", measureFrameHeight);
    }
  }

  return (
    <div class="html-body-frame">
      {blocked() ? (
        <div class="html-body-notice">
          <span>
            Remote images are blocked. Loading them tells the sender you opened
            this message.
          </span>
          <button
            type="button"
            onClick={() => setImageConsent(messageIdentity())}
          >
            Load images
          </button>
        </div>
      ) : null}
      <iframe
        ref={iframeRef}
        class="html-body-iframe"
        title={props.title ?? "Message body"}
        sandbox="allow-same-origin"
        referrerpolicy="no-referrer"
        srcdoc={frameDocument()}
        style={{ height: `${frameHeight()}px` }}
        onLoad={handleFrameLoad}
      />
    </div>
  );
}
