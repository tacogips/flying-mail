import { createSignal, For, type JSX } from "solid-js";
import type {
  AddressBookView,
  ContactEmailInput,
  ContactPhoneInput,
  ContactPostalAddressInput,
  ContactView,
  CreateContactInput,
  UpdateContactInput,
} from "../../api/contact-types";
import { pushToast } from "../../lib/toast";
import type {
  ContactDialogTarget,
  ContactStore,
} from "../../store/contact-store";

interface EmailDraft {
  readonly address: string;
  readonly label: string;
}

interface PhoneDraft {
  readonly number: string;
  readonly label: string;
}

interface PostalDraft {
  readonly formatted: string;
  readonly label: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toEmailDrafts(contact: ContactView | null): readonly EmailDraft[] {
  return (contact?.emails ?? []).map((email) => ({
    address: email.address,
    label: email.label ?? "",
  }));
}

function toPhoneDrafts(contact: ContactView | null): readonly PhoneDraft[] {
  return (contact?.phones ?? []).map((phone) => ({
    number: phone.number,
    label: phone.label ?? "",
  }));
}

function toPostalDrafts(contact: ContactView | null): readonly PostalDraft[] {
  return (contact?.postalAddresses ?? []).map((address) => ({
    formatted: address.formatted,
    label: address.label ?? "",
  }));
}

/** Create/edit dialog: modeled fields, repeatable email/phone/postal-address
 * rows with free-text labels (not a dropdown -- an enum would drop
 * iCloud's arbitrary labels), repeatable URLs, note, birthday. No photo
 * field, no group/`MEMBER` field: out of scope per the design doc.
 *
 * The address book is only choosable for a *new* contact:
 * `UpdateContactInput` carries no `addressBookId`, so an edit always keeps
 * the contact's existing book. */
export function ContactDialog(props: {
  readonly store: ContactStore;
  readonly addressBooks: readonly AddressBookView[];
  readonly target: ContactDialogTarget;
  readonly onClose: () => void;
}): JSX.Element {
  const existing = (): ContactView | null => props.target.contact;

  const [displayName, setDisplayName] = createSignal(
    existing()?.displayName ?? "",
  );
  const [givenName, setGivenName] = createSignal(existing()?.givenName ?? "");
  const [familyName, setFamilyName] = createSignal(
    existing()?.familyName ?? "",
  );
  const [nickname, setNickname] = createSignal(existing()?.nickname ?? "");
  const [organization, setOrganization] = createSignal(
    existing()?.organization ?? "",
  );
  const [title, setTitle] = createSignal(existing()?.title ?? "");
  const [note, setNote] = createSignal(existing()?.note ?? "");
  const [birthday, setBirthday] = createSignal(existing()?.birthday ?? "");
  const [emails, setEmails] = createSignal<readonly EmailDraft[]>(
    toEmailDrafts(existing()),
  );
  const [phones, setPhones] = createSignal<readonly PhoneDraft[]>(
    toPhoneDrafts(existing()),
  );
  const [postalAddresses, setPostalAddresses] = createSignal<
    readonly PostalDraft[]
  >(toPostalDrafts(existing()));
  const [urls, setUrls] = createSignal<readonly string[]>(
    existing()?.urls ?? [],
  );
  const [addressBookId, setAddressBookId] = createSignal(
    existing()?.addressBook.id ??
      props.target.addressBookId ??
      props.addressBooks[0]?.id ??
      "",
  );
  const [busy, setBusy] = createSignal(false);

  /** Rejects an invalid address outright (client-side check ahead of the
   * server's re-validation) and silently dedupes a case-insensitive repeat,
   * matching the domain's own dedup rule. */
  function buildEmailInputs(): readonly ContactEmailInput[] | null {
    const seen = new Set<string>();
    const result: ContactEmailInput[] = [];
    for (const draft of emails()) {
      const address = draft.address.trim();
      if (address.length === 0) {
        continue;
      }
      if (!EMAIL_PATTERN.test(address)) {
        pushToast("error", `${address} is not a valid email address`);
        return null;
      }
      const key = address.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const label = draft.label.trim();
      result.push({ address, ...(label.length === 0 ? {} : { label }) });
    }
    return result;
  }

  function buildPhoneInputs(): readonly ContactPhoneInput[] {
    return phones()
      .filter((draft) => draft.number.trim().length > 0)
      .map((draft) => {
        const label = draft.label.trim();
        return {
          number: draft.number.trim(),
          ...(label.length === 0 ? {} : { label }),
        };
      });
  }

  function buildPostalInputs(): readonly ContactPostalAddressInput[] {
    return postalAddresses()
      .filter((draft) => draft.formatted.trim().length > 0)
      .map((draft) => {
        const label = draft.label.trim();
        return {
          formatted: draft.formatted.trim(),
          ...(label.length === 0 ? {} : { label }),
        };
      });
  }

  function buildUrlInputs(): readonly string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const url of urls()) {
      const trimmed = url.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      result.push(trimmed);
    }
    return result;
  }

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    if (displayName().trim().length === 0) {
      pushToast("error", "A display name is required");
      return;
    }
    const emailInputs = buildEmailInputs();
    if (emailInputs === null) {
      return;
    }
    setBusy(true);
    const current = existing();
    const shared = {
      displayName: displayName().trim(),
      ...(givenName().trim().length === 0
        ? {}
        : { givenName: givenName().trim() }),
      ...(familyName().trim().length === 0
        ? {}
        : { familyName: familyName().trim() }),
      ...(nickname().trim().length === 0
        ? {}
        : { nickname: nickname().trim() }),
      ...(organization().trim().length === 0
        ? {}
        : { organization: organization().trim() }),
      ...(title().trim().length === 0 ? {} : { title: title().trim() }),
      ...(note().trim().length === 0 ? {} : { note: note().trim() }),
      ...(birthday().length === 0 ? {} : { birthday: birthday() }),
      emails: emailInputs,
      phones: buildPhoneInputs(),
      postalAddresses: buildPostalInputs(),
      urls: buildUrlInputs(),
    };

    if (current === null) {
      if (addressBookId().length === 0) {
        setBusy(false);
        pushToast("error", "Choose an address book first");
        return;
      }
      const input: CreateContactInput = {
        addressBookId: addressBookId(),
        ...shared,
      };
      const created = await props.store.createContact(input);
      setBusy(false);
      if (created !== null) {
        props.onClose();
      }
      return;
    }

    const update: UpdateContactInput = { ...shared };
    const saved = await props.store.updateContact(current.id, update);
    setBusy(false);
    if (saved !== null) {
      props.onClose();
    }
  }

  return (
    <div
      class="contact-dialog__backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={existing() === null ? "New contact" : "Edit contact"}
      tabindex={-1}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          props.onClose();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          props.onClose();
        }
      }}
    >
      <form class="contact-dialog" onSubmit={(event) => void save(event)}>
        <h2>{existing() === null ? "New contact" : "Edit contact"}</h2>

        <div class="contact-dialog__field">
          <label for="contact-display-name">Display name</label>
          <input
            id="contact-display-name"
            value={displayName()}
            required
            onInput={(event) => setDisplayName(event.currentTarget.value)}
          />
        </div>

        <div class="contact-dialog__row">
          <div>
            <label for="contact-given-name">Given name</label>
            <input
              id="contact-given-name"
              value={givenName()}
              onInput={(event) => setGivenName(event.currentTarget.value)}
            />
          </div>
          <div>
            <label for="contact-family-name">Family name</label>
            <input
              id="contact-family-name"
              value={familyName()}
              onInput={(event) => setFamilyName(event.currentTarget.value)}
            />
          </div>
          <div>
            <label for="contact-nickname">Nickname</label>
            <input
              id="contact-nickname"
              value={nickname()}
              onInput={(event) => setNickname(event.currentTarget.value)}
            />
          </div>
        </div>

        <div class="contact-dialog__row">
          <div>
            <label for="contact-organization">Organization</label>
            <input
              id="contact-organization"
              value={organization()}
              onInput={(event) => setOrganization(event.currentTarget.value)}
            />
          </div>
          <div>
            <label for="contact-title">Title</label>
            <input
              id="contact-title"
              value={title()}
              onInput={(event) => setTitle(event.currentTarget.value)}
            />
          </div>
          <div>
            <label for="contact-birthday">Birthday</label>
            <input
              id="contact-birthday"
              type="date"
              value={birthday()}
              onInput={(event) => setBirthday(event.currentTarget.value)}
            />
          </div>
        </div>

        {existing() === null ? (
          <div class="contact-dialog__field">
            <label for="contact-book">Address book</label>
            <select
              id="contact-book"
              value={addressBookId()}
              onChange={(event) => setAddressBookId(event.currentTarget.value)}
            >
              <For each={props.addressBooks}>
                {(book) => (
                  <option value={book.id}>
                    {book.mailAddress.address} &mdash; {book.name}
                  </option>
                )}
              </For>
            </select>
          </div>
        ) : (
          <p class="contact-dialog__hint">
            Address book: {existing()?.addressBook.mailAddress.address} &mdash;{" "}
            {existing()?.addressBook.name}
          </p>
        )}

        <div class="contact-dialog__field">
          <span class="contact-dialog__grouplabel">Email</span>
          <div class="contact-dialog__list">
            <For each={emails()}>
              {(email, index) => (
                <div class="contact-dialog__listrow">
                  <input
                    placeholder="name@example.com"
                    value={email.address}
                    onInput={(event) =>
                      setEmails((current) =>
                        current.map((entry, position) =>
                          position === index()
                            ? { ...entry, address: event.currentTarget.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  <input
                    placeholder="Label"
                    value={email.label}
                    onInput={(event) =>
                      setEmails((current) =>
                        current.map((entry, position) =>
                          position === index()
                            ? { ...entry, label: event.currentTarget.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setEmails((current) =>
                        current.filter(
                          (_entry, position) => position !== index(),
                        ),
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              )}
            </For>
          </div>
          <button
            type="button"
            onClick={() => setEmails([...emails(), { address: "", label: "" }])}
          >
            Add email
          </button>
        </div>

        <div class="contact-dialog__field">
          <span class="contact-dialog__grouplabel">Phone</span>
          <div class="contact-dialog__list">
            <For each={phones()}>
              {(phone, index) => (
                <div class="contact-dialog__listrow">
                  <input
                    placeholder="+1 555 0100"
                    value={phone.number}
                    onInput={(event) =>
                      setPhones((current) =>
                        current.map((entry, position) =>
                          position === index()
                            ? { ...entry, number: event.currentTarget.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  <input
                    placeholder="Label"
                    value={phone.label}
                    onInput={(event) =>
                      setPhones((current) =>
                        current.map((entry, position) =>
                          position === index()
                            ? { ...entry, label: event.currentTarget.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setPhones((current) =>
                        current.filter(
                          (_entry, position) => position !== index(),
                        ),
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              )}
            </For>
          </div>
          <button
            type="button"
            onClick={() => setPhones([...phones(), { number: "", label: "" }])}
          >
            Add phone
          </button>
        </div>

        <div class="contact-dialog__field">
          <span class="contact-dialog__grouplabel">Postal address</span>
          <div class="contact-dialog__list">
            <For each={postalAddresses()}>
              {(address, index) => (
                <div class="contact-dialog__listrow">
                  <input
                    placeholder="123 Main St, Springfield"
                    value={address.formatted}
                    onInput={(event) =>
                      setPostalAddresses((current) =>
                        current.map((entry, position) =>
                          position === index()
                            ? { ...entry, formatted: event.currentTarget.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  <input
                    placeholder="Label"
                    value={address.label}
                    onInput={(event) =>
                      setPostalAddresses((current) =>
                        current.map((entry, position) =>
                          position === index()
                            ? { ...entry, label: event.currentTarget.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setPostalAddresses((current) =>
                        current.filter(
                          (_entry, position) => position !== index(),
                        ),
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              )}
            </For>
          </div>
          <button
            type="button"
            onClick={() =>
              setPostalAddresses([
                ...postalAddresses(),
                { formatted: "", label: "" },
              ])
            }
          >
            Add address
          </button>
        </div>

        <div class="contact-dialog__field">
          <span class="contact-dialog__grouplabel">URLs</span>
          <div class="contact-dialog__list">
            <For each={urls()}>
              {(url, index) => (
                <div class="contact-dialog__listrow">
                  <input
                    placeholder="https://example.com"
                    value={url}
                    onInput={(event) =>
                      setUrls((current) =>
                        current.map((entry, position) =>
                          position === index()
                            ? event.currentTarget.value
                            : entry,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setUrls((current) =>
                        current.filter(
                          (_entry, position) => position !== index(),
                        ),
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              )}
            </For>
          </div>
          <button type="button" onClick={() => setUrls([...urls(), ""])}>
            Add URL
          </button>
        </div>

        <div class="contact-dialog__field">
          <label for="contact-note">Notes</label>
          <textarea
            id="contact-note"
            rows="3"
            value={note()}
            onInput={(event) => setNote(event.currentTarget.value)}
          />
        </div>

        <div class="contact-dialog__actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" class="primary" disabled={busy()}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
