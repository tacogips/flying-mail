import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import {
  ADD_USER_CALENDAR_PERMISSION_MUTATION,
  ADD_USER_MAIL_PERMISSION_MUTATION,
  ADD_USER_TEMPLATE_PERMISSION_MUTATION,
  CREATE_USER_MUTATION,
  REMOVE_USER_CALENDAR_PERMISSION_MUTATION,
  REMOVE_USER_MAIL_PERMISSION_MUTATION,
  REMOVE_USER_TEMPLATE_PERMISSION_MUTATION,
  SET_USER_ACTIVE_MUTATION,
  SET_USER_ROLE_MUTATION,
  USERS_QUERY,
} from "../../api/documents";
import { graphqlRequest } from "../../api/graphql-client";
import type {
  CalendarCapability,
  MailDomainView,
  TemplateCapability,
  UserPermissionEffect,
  UserRole,
  UserView,
} from "../../api/schema-types";
import { describeErrors } from "../../lib/mutation-error";
import { isValidAddressPattern } from "../../lib/scope-format";
import { pushToast } from "../../lib/toast";
import { useStore } from "../../store/store-context";
import "./settings.css";

const ROLE_OPTIONS: readonly UserRole[] = ["ADMIN", "MEMBER", "VIEWER"];
const EFFECT_OPTIONS: readonly UserPermissionEffect[] = ["ALLOW", "DENY"];

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

/** One user's role/activation controls and its mail-permission rules.
 *
 * Split out of `UsersPage` so each row can hold its own add-rule form state
 * without every user sharing one signal. */
function UserRow(props: {
  readonly user: UserView;
  readonly domains: readonly MailDomainView[];
  readonly onSetRole: (role: UserRole) => void;
  readonly onSetActive: (active: boolean) => void;
  readonly onAddRule: (form: AddRuleFormState) => Promise<boolean>;
  readonly onRemoveRule: (permissionId: string) => void;
  readonly onAddTemplateRule: (
    capability: TemplateCapability,
    effect: UserPermissionEffect,
  ) => void;
  readonly onRemoveTemplateRule: (id: string) => void;
  readonly onAddCalendarRule: (
    capability: CalendarCapability,
    effect: UserPermissionEffect,
  ) => void;
  readonly onRemoveCalendarRule: (id: string) => void;
}): JSX.Element {
  const [form, setForm] = createSignal<AddRuleFormState>(EMPTY_RULE_FORM);
  const [adding, setAdding] = createSignal(false);

  async function submitRule(event: Event): Promise<void> {
    event.preventDefault();
    setAdding(true);
    const added = await props.onAddRule(form());
    setAdding(false);
    if (added) {
      setForm(EMPTY_RULE_FORM);
    }
  }

  return (
    <div class="panel user-row">
      <div class="row user-row-header">
        <div>
          <strong>{props.user.name}</strong>{" "}
          <span class="muted">{props.user.email}</span>
        </div>
        <select
          aria-label={`Role for ${props.user.email}`}
          value={props.user.role}
          onChange={(event) =>
            props.onSetRole(event.currentTarget.value as UserRole)
          }
        >
          <For each={ROLE_OPTIONS}>
            {(value) => <option value={value}>{value}</option>}
          </For>
        </select>
        <Show
          when={props.user.active}
          fallback={
            <button type="button" onClick={() => props.onSetActive(true)}>
              Reactivate
            </button>
          }
        >
          <button
            type="button"
            class="danger"
            onClick={() => props.onSetActive(false)}
          >
            Deactivate
          </button>
        </Show>
      </div>

      <h3>Mail permission rules</h3>
      <Show
        when={props.user.permissions.length > 0}
        fallback={<p class="muted">No rules yet.</p>}
      >
        <ul class="scope-list permission-list">
          <For each={props.user.permissions}>
            {(permission) => (
              <li class="permission-row">
                <span>
                  {permission.effect}{" "}
                  {permission.domain === null
                    ? "All domains"
                    : permission.domain.name}{" "}
                  <code>{permission.addressPattern}</code>
                </span>
                <button
                  type="button"
                  class="danger"
                  aria-label={`Remove rule ${permission.addressPattern}`}
                  onClick={() => props.onRemoveRule(permission.id)}
                >
                  Remove
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <form class="scope-row" onSubmit={(event) => void submitRule(event)}>
        <select
          aria-label="Effect"
          value={form().effect}
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
          onInput={(event) =>
            setForm((current) => ({
              ...current,
              addressPattern: event.currentTarget.value,
            }))
          }
        />
        <button type="submit" disabled={adding()}>
          Add rule
        </button>
      </form>

      <CapabilityRules
        title="Template permission rules"
        capabilities={TEMPLATE_CAPABILITIES}
        rules={props.user.templatePermissions}
        onAdd={props.onAddTemplateRule}
        onRemove={props.onRemoveTemplateRule}
      />

      <CapabilityRules
        title="Calendar permission rules"
        capabilities={CALENDAR_CAPABILITIES}
        rules={props.user.calendarPermissions}
        onAdd={props.onAddCalendarRule}
        onRemove={props.onRemoveCalendarRule}
      />
    </div>
  );
}

const TEMPLATE_CAPABILITIES: readonly TemplateCapability[] = [
  "TEMPLATE_READ",
  "TEMPLATE_CREATE",
  "TEMPLATE_UPDATE",
  "TEMPLATE_DELETE",
];

const CALENDAR_CAPABILITIES: readonly CalendarCapability[] = [
  "CALENDAR_READ",
  "CALENDAR_WRITE",
];

/** Template and calendar rules share a shape -- a capability plus an
 * ALLOW/DENY effect -- so one editor serves both rather than two near-copies
 * that would drift. A calendar rule's owner axis is deliberately not exposed
 * here: the common case is "all owners", and per-owner scoping remains
 * available through the API. */
function CapabilityRules<T extends string>(props: {
  readonly title: string;
  readonly capabilities: readonly T[];
  readonly rules: readonly {
    readonly id: string;
    readonly capability: T;
    readonly effect: UserPermissionEffect;
  }[];
  readonly onAdd: (capability: T, effect: UserPermissionEffect) => void;
  readonly onRemove: (id: string) => void;
}): JSX.Element {
  const [capability, setCapability] = createSignal<T>(
    props.capabilities[0] as T,
  );
  const [effect, setEffect] = createSignal<UserPermissionEffect>("ALLOW");

  return (
    <>
      <h3>{props.title}</h3>
      <Show
        when={props.rules.length > 0}
        fallback={<p class="muted">No rules yet; the role default applies.</p>}
      >
        <ul class="scope-list permission-list">
          <For each={props.rules}>
            {(rule) => (
              <li class="permission-row">
                <span>
                  {rule.effect} <code>{rule.capability}</code>
                </span>
                <button
                  type="button"
                  class="danger"
                  aria-label={`Remove rule ${rule.capability}`}
                  onClick={() => props.onRemove(rule.id)}
                >
                  Remove
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <form
        class="scope-row"
        onSubmit={(event) => {
          event.preventDefault();
          props.onAdd(capability(), effect());
        }}
      >
        <select
          aria-label={`${props.title} effect`}
          value={effect()}
          onChange={(event) =>
            setEffect(event.currentTarget.value as UserPermissionEffect)
          }
        >
          <For each={EFFECT_OPTIONS}>
            {(value) => <option value={value}>{value}</option>}
          </For>
        </select>
        <select
          aria-label={`${props.title} capability`}
          value={capability()}
          // Updater form: with `T extends string`, Solid cannot tell a bare
          // value from a setter function.
          onChange={(event) => {
            const next = event.currentTarget.value as T;
            setCapability(() => next);
          }}
        >
          <For each={props.capabilities}>
            {(value) => <option value={value}>{value}</option>}
          </For>
        </select>
        <button type="submit">Add rule</button>
      </form>
    </>
  );
}

export default function UsersPage(): JSX.Element {
  const store = useStore();
  const [users, setUsers] = createSignal<readonly UserView[]>([]);
  const [loading, setLoading] = createSignal(false);

  const [email, setEmail] = createSignal("");
  const [name, setName] = createSignal("");
  const [role, setRole] = createSignal<UserRole>("MEMBER");
  const [busy, setBusy] = createSignal(false);

  async function reload(): Promise<void> {
    setLoading(true);
    const result = await graphqlRequest<{
      readonly users: readonly UserView[];
    }>(USERS_QUERY);
    setLoading(false);
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    setUsers(result.data.users);
  }

  onMount(() => {
    void store.loadReferenceData();
    void reload();
  });

  async function createUser(event: Event): Promise<void> {
    event.preventDefault();
    setBusy(true);
    const result = await graphqlRequest<
      { readonly createUser: UserView },
      Record<string, unknown>
    >(CREATE_USER_MUTATION, {
      input: { email: email(), name: name(), role: role() },
    });
    setBusy(false);
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    setEmail("");
    setName("");
    setRole("MEMBER");
    pushToast(
      "success",
      "User created. They sign in through the existing email link flow.",
    );
    await reload();
  }

  async function setRoleFor(user: UserView, nextRole: UserRole): Promise<void> {
    if (nextRole === user.role) {
      return;
    }
    const result = await graphqlRequest<
      { readonly setUserRole: UserView },
      Record<string, unknown>
    >(SET_USER_ROLE_MUTATION, { id: user.id, role: nextRole });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    await reload();
  }

  async function setActiveFor(user: UserView, active: boolean): Promise<void> {
    if (!active) {
      const confirmed = window.confirm(
        `Deactivate ${user.email}? They will no longer be able to sign in.`,
      );
      if (!confirmed) {
        return;
      }
    }
    const result = await graphqlRequest<
      { readonly setUserActive: UserView },
      Record<string, unknown>
    >(SET_USER_ACTIVE_MUTATION, { id: user.id, active });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    pushToast("success", active ? "User reactivated" : "User deactivated");
    await reload();
  }

  async function addRuleFor(
    user: UserView,
    form: AddRuleFormState,
  ): Promise<boolean> {
    if (!isValidAddressPattern(form.addressPattern)) {
      pushToast(
        "error",
        `"${form.addressPattern}" is not a valid address pattern`,
      );
      return false;
    }
    const result = await graphqlRequest<
      { readonly addUserMailPermission: { readonly id: string } },
      Record<string, unknown>
    >(ADD_USER_MAIL_PERMISSION_MUTATION, {
      userId: user.id,
      input: {
        effect: form.effect,
        domainId: form.domainId === "" ? null : form.domainId,
        addressPattern: form.addressPattern,
      },
    });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return false;
    }
    await reload();
    return true;
  }

  async function removeRule(permissionId: string): Promise<void> {
    const result = await graphqlRequest<
      { readonly removeUserMailPermission: boolean },
      Record<string, unknown>
    >(REMOVE_USER_MAIL_PERMISSION_MUTATION, { id: permissionId });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    await reload();
  }

  /** Template and calendar rules take the same `(userId, input)` shape, so
   * one helper drives both mutations rather than four near-identical ones. */
  async function addCapabilityRule(
    document: string,
    userId: string,
    capability: string,
    effect: UserPermissionEffect,
  ): Promise<void> {
    const result = await graphqlRequest<
      Record<string, unknown>,
      Record<string, unknown>
    >(document, { userId, input: { capability, effect } });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    await reload();
  }

  async function removeCapabilityRule(
    document: string,
    id: string,
  ): Promise<void> {
    const result = await graphqlRequest<
      Record<string, unknown>,
      Record<string, unknown>
    >(document, { id });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    await reload();
  }

  return (
    <div class="settings-page">
      <h1>Users</h1>
      <p class="muted">
        A matching DENY always wins, even over an ADMIN's default access to
        every mailbox. MEMBER and VIEWER need an explicit ALLOW rule before they
        can see any mail. VIEWER is read-only and can never send or change mail,
        regardless of its assignments.
      </p>

      <form class="panel" onSubmit={(event) => void createUser(event)}>
        <h2>Create a user</h2>
        <div class="field">
          <label for="user-email">Email</label>
          <input
            id="user-email"
            type="email"
            required
            placeholder="person@example.com"
            value={email()}
            onInput={(event) => setEmail(event.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for="user-name">Name</label>
          <input
            id="user-name"
            type="text"
            required
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for="user-role">Role</label>
          <select
            id="user-role"
            value={role()}
            onChange={(event) => setRole(event.currentTarget.value as UserRole)}
          >
            <For each={ROLE_OPTIONS}>
              {(value) => <option value={value}>{value}</option>}
            </For>
          </select>
        </div>
        <button type="submit" class="primary" disabled={busy()}>
          Create user
        </button>
      </form>

      <div class="panel">
        <h2>All users</h2>
        <Show when={!loading()} fallback={<p class="muted">Loading...</p>}>
          <Show
            when={users().length > 0}
            fallback={<p class="muted">No users yet.</p>}
          >
            <For each={users()}>
              {(user) => (
                <UserRow
                  user={user}
                  domains={store.domains()}
                  onSetRole={(nextRole) => void setRoleFor(user, nextRole)}
                  onSetActive={(active) => void setActiveFor(user, active)}
                  onAddRule={(form) => addRuleFor(user, form)}
                  onRemoveRule={(id) => void removeRule(id)}
                  onAddTemplateRule={(capability, effect) =>
                    void addCapabilityRule(
                      ADD_USER_TEMPLATE_PERMISSION_MUTATION,
                      user.id,
                      capability,
                      effect,
                    )
                  }
                  onRemoveTemplateRule={(id) =>
                    void removeCapabilityRule(
                      REMOVE_USER_TEMPLATE_PERMISSION_MUTATION,
                      id,
                    )
                  }
                  onAddCalendarRule={(capability, effect) =>
                    void addCapabilityRule(
                      ADD_USER_CALENDAR_PERMISSION_MUTATION,
                      user.id,
                      capability,
                      effect,
                    )
                  }
                  onRemoveCalendarRule={(id) =>
                    void removeCapabilityRule(
                      REMOVE_USER_CALENDAR_PERMISSION_MUTATION,
                      id,
                    )
                  }
                />
              )}
            </For>
          </Show>
        </Show>
      </div>

      <a href="/">Back to mail</a>
    </div>
  );
}
