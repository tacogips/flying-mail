import { createSignal, For, type JSX, Show } from "solid-js";
import type { UserView } from "../../api/schema-types";

function mailRuleLabel(permission: UserView["permissions"][number]): string {
  const domain = permission.domain?.name ?? "All domains";
  return `${permission.effect} ${domain} ${permission.addressPattern}`;
}

/** Compact permission summaries and actions for one user. */
export default function UserRow(props: {
  readonly user: UserView;
  readonly onEdit: () => void;
  readonly onResendInvitation: () => Promise<void>;
}): JSX.Element {
  const pending = () =>
    props.user.active && props.user.invitationStatus === "PENDING";
  const [sending, setSending] = createSignal(false);
  const mailRules = () => props.user.permissions;
  const hasMailAllow = () =>
    mailRules().some((rule) => rule.effect === "ALLOW");
  const denyRules = () => mailRules().filter((rule) => rule.effect === "DENY");
  const status = () =>
    !props.user.active
      ? "Inactive"
      : pending()
        ? "Invitation pending"
        : "Active";

  return (
    <article class="users-list__row">
      <div class="users-list__identity">
        <strong>{props.user.name}</strong>
        <span class="users-list__email">{props.user.email}</span>
      </div>
      <div class="users-list__badges">
        <span
          class={`users-list__badge users-list__role users-list__role--${props.user.role.toLowerCase()}`}
        >
          {props.user.role}
        </span>
        <span
          class={`users-list__badge users-list__status users-list__status--${status().toLowerCase().replaceAll(" ", "-")}`}
        >
          {status()}
        </span>
      </div>
      <div class="users-list__summaries">
        <section class="users-list__summary" aria-label="Mail access">
          <span class="users-list__summary-label">Mail</span>
          <div class="users-list__chips">
            <Show
              when={props.user.role === "ADMIN" && denyRules().length === 0}
            >
              <span class="users-list__chip" title="All mailboxes">
                All mailboxes
              </span>
            </Show>
            <Show when={props.user.role === "ADMIN" && denyRules().length > 0}>
              <span class="users-list__chip" title="All mailboxes except">
                All mailboxes except
              </span>
            </Show>
            <Show when={props.user.role !== "ADMIN" && !hasMailAllow()}>
              <span
                class="users-list__chip users-list__chip--warning"
                title="No mail access"
              >
                No mail access
              </span>
            </Show>
            <For each={props.user.role === "ADMIN" ? denyRules() : mailRules()}>
              {(permission) => {
                const label = mailRuleLabel(permission);
                return (
                  <span
                    class={`users-list__chip${permission.effect === "DENY" ? " users-list__chip--deny" : ""}`}
                    title={label}
                  >
                    {label}
                  </span>
                );
              }}
            </For>
          </div>
        </section>
        <section class="users-list__summary" aria-label="Template permissions">
          <span class="users-list__summary-label">Templates</span>
          <div class="users-list__chips">
            <Show when={props.user.templatePermissions.length === 0}>
              <span class="users-list__chip" title="Role default">
                Role default
              </span>
            </Show>
            <For each={props.user.templatePermissions}>
              {(permission) => {
                const label = `${permission.effect} ${permission.capability}`;
                return (
                  <span
                    class={`users-list__chip${permission.effect === "DENY" ? " users-list__chip--deny" : ""}`}
                    title={label}
                  >
                    {label}
                  </span>
                );
              }}
            </For>
          </div>
        </section>
      </div>
      <div class="users-list__actions">
        <button
          type="button"
          data-user-id={props.user.id}
          aria-label={`Edit ${props.user.email}`}
          onClick={props.onEdit}
        >
          Edit
        </button>
        <Show when={pending()}>
          <button
            type="button"
            aria-label={`Resend invitation to ${props.user.email}`}
            disabled={sending()}
            onClick={() => {
              if (sending()) {
                return;
              }
              setSending(true);
              void props.onResendInvitation().finally(() => setSending(false));
            }}
          >
            Resend invitation
          </button>
        </Show>
      </div>
    </article>
  );
}
