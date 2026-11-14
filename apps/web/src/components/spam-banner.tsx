import type { JSX } from "solid-js";
import type { MessageView } from "../api/schema-types";
import "./spam-banner.css";

/** Shown above a message classified as spam. The score is surfaced
 * deliberately: a self-hosted filter that cannot explain itself is one an
 * operator cannot tune. */
export function SpamBanner(props: {
  readonly message: MessageView;
  readonly onNotSpam: () => void;
}): JSX.Element {
  return (
    <div class="spam-banner">
      <span>
        Marked as spam
        {props.message.spamScore === null
          ? ""
          : ` (score ${props.message.spamScore.toFixed(2)})`}
        .
      </span>
      <button type="button" onClick={() => props.onNotSpam()}>
        Not spam
      </button>
    </div>
  );
}
