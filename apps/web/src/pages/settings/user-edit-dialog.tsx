import {
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type {
  MailDomainView,
  TemplateCapability,
  UserPermissionEffect,
  UserRole,
  UserView,
} from "../../api/schema-types";
import { isValidAddressPattern } from "../../lib/scope-format";

const ROLE_OPTIONS: readonly UserRole[] = ["ADMIN", "MEMBER", "VIEWER"];
const EFFECT_OPTIONS: readonly UserPermissionEffect[] = ["ALLOW", "DENY"];
const TEMPLATE_CAPABILITIES: readonly TemplateCapability[] = [
  "TEMPLATE_READ",
  "TEMPLATE_CREATE",
  "TEMPLATE_UPDATE",
  "TEMPLATE_DELETE",
];

interface AddRuleFormState {
  readonly effect: UserPermissionEffect;
  readonly domainId: string;
  readonly addressPattern: string;
}

const EMPTY_RULE_FORM: AddRuleFormState = {
  effect: "ALLOW",
  domainId: "",
  addressPattern: "*",
};

type ActionResult = Promise<string | null>;

/** Accessible modal for immediately editing one user's access settings. */
export default function UserEditDialog(props: {
  readonly user: UserView;
  readonly domains: readonly MailDomainView[];
  readonly onClose: () => void;
  readonly onSetRole: (role: UserRole) => ActionResult;
  readonly onSetActive: (active: boolean) => ActionResult;
  readonly onResendInvitation: () => ActionResult;
  readonly onAddMailRule: (form: AddRuleFormState) => ActionResult;
  readonly onRemoveMailRule: (id: string) => ActionResult;
  readonly onAddTemplateRule: (
    capability: TemplateCapability,
    effect: UserPermissionEffect,
  ) => ActionResult;
  readonly onRemoveTemplateRule: (id: string) => ActionResult;
}): JSX.Element {
  const [form, setForm] = createSignal<AddRuleFormState>(EMPTY_RULE_FORM);
  const [templateCapability, setTemplateCapability] =
    createSignal<TemplateCapability>("TEMPLATE_READ");
  const [templateEffect, setTemplateEffect] =
    createSignal<UserPermissionEffect>("ALLOW");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let dialog: HTMLDivElement | undefined;
  let roleSelect: HTMLSelectElement | undefined;

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown);
    roleSelect?.focus();
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown);
    const trigger = document.querySelector<HTMLButtonElement>(
      `[data-user-id="${props.user.id}"]`,
    );
    trigger?.focus();
  });

  function focusableElements(): HTMLElement[] {
    if (dialog === undefined) {
      return [];
    }
    return Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const items = focusableElements();
    const first = items[0];
    const last = items.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      dialog?.focus();
    } else if (
      !(document.activeElement instanceof HTMLElement) ||
      !items.includes(document.activeElement)
    ) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function perform(action: () => ActionResult): Promise<void> {
    setBusy(true);
    setError("");
    const message = await action();
    setBusy(false);
    if (message !== null) {
      setError(message);
    }
    if (dialog !== undefined && !dialog.contains(document.activeElement)) {
      dialog.focus();
    }
  }

  async function submitMailRule(event: Event): Promise<void> {
    event.preventDefault();
    if (!isValidAddressPattern(form().addressPattern)) {
      setError(`"${form().addressPattern}" is not a valid address pattern`);
      return;
    }
    await perform(() => props.onAddMailRule(form()));
    if (error().length === 0) {
      setForm(EMPTY_RULE_FORM);
    }
  }

  return (
    <div
      class="users-dialog-backdrop"
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby="users-dialog-title"
      tabindex={-1}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          props.onClose();
        }
      }}
      onKeyDown={(event) => {
        if (
          event.target === event.currentTarget &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <div class="users-dialog">
        <header class="users-dialog__header">
          <div>
            <h2 id="users-dialog-title">{props.user.name}</h2>
            <p class="muted">{props.user.email}</p>
          </div>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={props.onClose}
          >
            Close
          </button>
        </header>
        <div class="users-dialog__body">
          <Show when={error().length > 0}>
            <p class="users-dialog__error" role="alert">
              {error()}
            </p>
          </Show>
          <section class="users-dialog__section" aria-label="User account">
            <label class="users-dialog__field">
              <span>Role</span>
              <select
                ref={roleSelect}
                aria-label={`Role for ${props.user.email}`}
                value={props.user.role}
                disabled={busy()}
                onChange={(event) => {
                  const nextRole = event.currentTarget.value as UserRole;
                  void perform(() => props.onSetRole(nextRole)).then(() => {
                    if (roleSelect !== undefined) {
                      roleSelect.value = props.user.role;
                    }
                  });
                }}
              >
                <For each={ROLE_OPTIONS}>
                  {(value) => <option value={value}>{value}</option>}
                </For>
              </select>
            </label>
            <button
              type="button"
              class={props.user.active ? "danger" : ""}
              disabled={busy()}
              onClick={() =>
                void perform(() => props.onSetActive(!props.user.active))
              }
            >
              {props.user.active ? "Deactivate" : "Reactivate"}
            </button>
            <Show
              when={
                props.user.active && props.user.invitationStatus === "PENDING"
              }
            >
              <button
                type="button"
                disabled={busy()}
                aria-label={`Resend invitation to ${props.user.email}`}
                onClick={() => void perform(props.onResendInvitation)}
              >
                Resend invitation
              </button>
            </Show>
          </section>

          <section class="users-dialog__section">
            <h3>Mail permission rules</h3>
            <Show
              when={props.user.permissions.length > 0}
              fallback={<p class="muted">No rules yet.</p>}
            >
              <ul class="users-dialog__rules">
                <For each={props.user.permissions}>
                  {(permission) => (
                    <li>
                      <span>
                        {permission.effect}{" "}
                        {permission.domain?.name ?? "All domains"}{" "}
                        <code>{permission.addressPattern}</code>
                      </span>
                      <button
                        type="button"
                        class="danger"
                        disabled={busy()}
                        aria-label={`Remove ${permission.effect} ${permission.domain?.name ?? "All domains"} ${permission.addressPattern}`}
                        onClick={() =>
                          void perform(() =>
                            props.onRemoveMailRule(permission.id),
                          )
                        }
                      >
                        Remove
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <form
              class="scope-row users-dialog__rule-form"
              onSubmit={(event) => void submitMailRule(event)}
            >
              <select
                aria-label="Effect"
                value={form().effect}
                disabled={busy()}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    effect: event.currentTarget.value as UserPermissionEffect,
                  }))
                }
              >
                <For each={EFFECT_OPTIONS}>
                  {(value) => <option value={value}>{value}</option>}
                </For>
              </select>
              <select
                aria-label="Domain"
                value={form().domainId}
                disabled={busy()}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    domainId: event.currentTarget.value,
                  }))
                }
              >
                <option value="">All domains</option>
                <For each={props.domains}>
                  {(domain) => <option value={domain.id}>{domain.name}</option>}
                </For>
              </select>
              <input
                type="text"
                aria-label="Address pattern"
                placeholder="*  |  *@example.com  |  support@example.com"
                value={form().addressPattern}
                disabled={busy()}
                onInput={(event) =>
                  setForm((current) => ({
                    ...current,
                    addressPattern: event.currentTarget.value,
                  }))
                }
              />
              <button type="submit" disabled={busy()}>
                Add rule
              </button>
            </form>
          </section>

          <section class="users-dialog__section">
            <h3>Template permission rules</h3>
            <Show
              when={props.user.templatePermissions.length > 0}
              fallback={
                <p class="muted">No rules yet; the role default applies.</p>
              }
            >
              <ul class="users-dialog__rules">
                <For each={props.user.templatePermissions}>
                  {(rule) => (
                    <li>
                      <span>
                        {rule.effect} <code>{rule.capability}</code>
                      </span>
                      <button
                        type="button"
                        class="danger"
                        disabled={busy()}
                        aria-label={`Remove rule ${rule.capability}`}
                        onClick={() =>
                          void perform(() =>
                            props.onRemoveTemplateRule(rule.id),
                          )
                        }
                      >
                        Remove
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <form
              class="scope-row users-dialog__rule-form"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(() =>
                  props.onAddTemplateRule(
                    templateCapability(),
                    templateEffect(),
                  ),
                );
              }}
            >
              <select
                aria-label="Template permission rules effect"
                value={templateEffect()}
                disabled={busy()}
                onChange={(event) =>
                  setTemplateEffect(
                    event.currentTarget.value as UserPermissionEffect,
                  )
                }
              >
                <For each={EFFECT_OPTIONS}>
                  {(value) => <option value={value}>{value}</option>}
                </For>
              </select>
              <select
                aria-label="Template permission rules capability"
                value={templateCapability()}
                disabled={busy()}
                onChange={(event) =>
                  setTemplateCapability(
                    event.currentTarget.value as TemplateCapability,
                  )
                }
              >
                <For each={TEMPLATE_CAPABILITIES}>
                  {(value) => <option value={value}>{value}</option>}
                </For>
              </select>
              <button type="submit" disabled={busy()}>
                Add rule
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
