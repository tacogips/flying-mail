import { createMemo, createSignal, type JSX } from "solid-js";
import {
  buildMailFrameDocument,
  hasBlockedImages,
  sanitizeMailHtml,
} from "../lib/mail-html";
import "./html-body-frame.css";

/**
 * Renders an HTML mail body.
 *
 * The security posture here is deliberately belt-and-braces, because mail
 * bodies are attacker-controlled:
 *
 * 1. `sanitizeMailHtml` strips scripting constructs and dangerous URLs.
 * 2. The result is rendered in an iframe whose `sandbox` attribute is
 *    **empty** -- no `allow-scripts`, no `allow-same-origin` -- so even a
 *    sanitizer bypass gets no script execution and no access to the session
 *    cookie or `localStorage`.
 * 3. `srcdoc` (rather than a blob URL) keeps the frame an opaque origin.
 * 4. The document itself carries a restrictive CSP meta tag.
 *
 * Remote images start blocked. That is a privacy measure rather than an XSS
 * one: loading them on open is what tells a sender the mail was read.
 */
export function HtmlBodyFrame(props: {
  readonly html: string;
  readonly title?: string;
}): JSX.Element {
  const [loadRemoteImages, setLoadRemoteImages] = createSignal(false);

  const sanitized = createMemo(() =>
    sanitizeMailHtml(props.html, { loadRemoteImages: loadRemoteImages() }),
  );
  const blocked = createMemo(
    () => !loadRemoteImages() && hasBlockedImages(sanitized()),
  );
  const document = createMemo(() =>
    buildMailFrameDocument(sanitized(), loadRemoteImages()),
  );

  return (
    <div class="html-body-frame">
      {blocked() ? (
        <div class="html-body-notice">
          <span>
            Remote images are blocked. Loading them tells the sender you opened
            this message.
          </span>
          <button type="button" onClick={() => setLoadRemoteImages(true)}>
            Load images
          </button>
        </div>
      ) : null}
      <iframe
        class="html-body-iframe"
        title={props.title ?? "Message body"}
        sandbox=""
        referrerpolicy="no-referrer"
        srcdoc={document()}
      />
    </div>
  );
}
