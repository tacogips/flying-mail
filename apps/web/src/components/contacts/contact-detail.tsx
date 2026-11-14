import { For, type JSX, Show } from "solid-js";
import type { ContactView } from "../../api/contact-types";

/** Read-only rendering of the modeled fields for the selected contact. The
 * edit affordance -- and the delete button beside it -- is hidden entirely
 * when `canWrite` is false, which is how a VIEWER-role signed-in user sees
 * no create/edit/delete affordance anywhere on the `/contacts` page. */
export function ContactDetail(props: {
  readonly contact: ContactView | null;
  readonly canWrite: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  return (
    <Show
      when={props.contact}
      fallback={<p class="empty">Select a contact.</p>}
    >
      {(contact) => (
        <article class="contact-detail">
          <header class="contact-detail__header">
            <div>
              <h2>{contact().displayName}</h2>
              <p class="contact-detail__meta muted">
                {contact().addressBook.name} &middot;{" "}
                {contact().addressBook.mailAddress.address}
              </p>
            </div>
            <Show when={props.canWrite}>
              <div class="contact-detail__actions">
                <button type="button" onClick={() => props.onEdit()}>
                  Edit
                </button>
                <button
                  type="button"
                  class="danger"
                  onClick={() => props.onDelete()}
                >
                  Delete
                </button>
              </div>
            </Show>
          </header>

          <Show
            when={contact().organization !== null || contact().title !== null}
          >
            <p class="contact-detail__role">
              {[contact().title, contact().organization]
                .filter((value): value is string => value !== null)
                .join(", ")}
            </p>
          </Show>

          <Show when={contact().nickname !== null}>
            <p class="muted">&ldquo;{contact().nickname}&rdquo;</p>
          </Show>

          <Show when={contact().emails.length > 0}>
            <section class="contact-detail__section">
              <h3>Email</h3>
              <ul>
                <For each={contact().emails}>
                  {(email) => (
                    <li>
                      <a href={`mailto:${email.address}`}>{email.address}</a>
                      <Show when={email.label !== null}>
                        {" "}
                        <span class="muted">({email.label})</span>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>

          <Show when={contact().phones.length > 0}>
            <section class="contact-detail__section">
              <h3>Phone</h3>
              <ul>
                <For each={contact().phones}>
                  {(phone) => (
                    <li>
                      {phone.number}
                      <Show when={phone.label !== null}>
                        {" "}
                        <span class="muted">({phone.label})</span>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>

          <Show when={contact().postalAddresses.length > 0}>
            <section class="contact-detail__section">
              <h3>Address</h3>
              <ul>
                <For each={contact().postalAddresses}>
                  {(address) => (
                    <li>
                      {address.formatted}
                      <Show when={address.label !== null}>
                        {" "}
                        <span class="muted">({address.label})</span>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>

          <Show when={contact().urls.length > 0}>
            <section class="contact-detail__section">
              <h3>Links</h3>
              <ul>
                <For each={contact().urls}>
                  {(url) => (
                    <li>
                      <a href={url} target="_blank" rel="noreferrer">
                        {url}
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>

          <Show when={contact().birthday !== null}>
            <p>
              <strong>Birthday:</strong> {contact().birthday}
            </p>
          </Show>

          <Show when={contact().note !== null}>
            <section class="contact-detail__section">
              <h3>Notes</h3>
              <p class="contact-detail__note">{contact().note}</p>
            </section>
          </Show>
        </article>
      )}
    </Show>
  );
}
