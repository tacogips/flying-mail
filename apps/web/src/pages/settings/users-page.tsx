import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import {
  ADD_USER_MAIL_PERMISSION_MUTATION,
  ADD_USER_TEMPLATE_PERMISSION_MUTATION,
  CREATE_USER_MUTATION,
  REMOVE_USER_MAIL_PERMISSION_MUTATION,
  REMOVE_USER_TEMPLATE_PERMISSION_MUTATION,
  RESEND_INVITATION_MUTATION,
  SET_USER_ACTIVE_MUTATION,
  SET_USER_ROLE_MUTATION,
  USERS_QUERY,
} from "../../api/documents";
import { graphqlRequest } from "../../api/graphql-client";
import type {
  TemplateCapability,
  UserPermissionEffect,
  UserRole,
  UserView,
} from "../../api/schema-types";
import { describeErrors } from "../../lib/mutation-error";
import { pushToast } from "../../lib/toast";
import { useStore } from "../../store/store-context";
import UserEditDialog from "./user-edit-dialog";
import UserRow from "./user-row";
import "./settings.css";
import "./users-page.css";

const ROLE_OPTIONS: readonly UserRole[] = ["ADMIN", "MEMBER", "VIEWER"];

interface AddRuleFormState {
  readonly effect: UserPermissionEffect;
  readonly domainId: string;
  readonly addressPattern: string;
}

export default function UsersPage(): JSX.Element {
  const store = useStore();
  const [users, setUsers] = createSignal<readonly UserView[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [selectedUserId, setSelectedUserId] = createSignal<string | null>(null);
  const [dialogOpen, setDialogOpen] = createSignal(false);

  const [email, setEmail] = createSignal("");
  const [name, setName] = createSignal("");
  const [role, setRole] = createSignal<UserRole>("MEMBER");
  const [busy, setBusy] = createSignal(false);

  const selectedUser = () =>
    users().find((user) => user.id === selectedUserId()) ?? null;

  function getSelectedUser(): UserView {
    const user = selectedUser();
    if (user === null) {
      throw new Error("No user is selected for editing");
    }
    return user;
  }

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
      await reload();
      return;
    }
    setEmail("");
    setName("");
    setRole("MEMBER");
    pushToast("success", `Invitation sent to ${result.data.createUser.email}`);
    await reload();
  }

  async function resendInvitation(user: UserView): Promise<string | null> {
    const result = await graphqlRequest<
      { readonly resendInvitation: UserView },
      Record<string, unknown>
    >(RESEND_INVITATION_MUTATION, { userId: user.id });
    if (!result.ok) {
      const message = describeErrors(result.errors);
      pushToast("error", message);
      return message;
    }
    pushToast("success", `Invitation resent to ${user.email}`);
    await reload();
    return null;
  }

  async function setRoleFor(
    user: UserView,
    nextRole: UserRole,
  ): Promise<string | null> {
    if (nextRole === user.role) {
      return null;
    }
    const result = await graphqlRequest<
      { readonly setUserRole: UserView },
      Record<string, unknown>
    >(SET_USER_ROLE_MUTATION, { id: user.id, role: nextRole });
    if (!result.ok) {
      return describeErrors(result.errors);
    }
    await reload();
    return null;
  }

  async function setActiveFor(
    user: UserView,
    active: boolean,
  ): Promise<string | null> {
    if (!active) {
      const confirmed = window.confirm(
        `Deactivate ${user.email}? They will no longer be able to sign in.`,
      );
      if (!confirmed) {
        return null;
      }
    }
    const result = await graphqlRequest<
      { readonly setUserActive: UserView },
      Record<string, unknown>
    >(SET_USER_ACTIVE_MUTATION, { id: user.id, active });
    if (!result.ok) {
      return describeErrors(result.errors);
    }
    pushToast("success", active ? "User reactivated" : "User deactivated");
    await reload();
    return null;
  }

  async function addRuleFor(
    userId: string,
    form: AddRuleFormState,
  ): Promise<string | null> {
    const result = await graphqlRequest<
      { readonly addUserMailPermission: { readonly id: string } },
      Record<string, unknown>
    >(ADD_USER_MAIL_PERMISSION_MUTATION, {
      userId,
      input: {
        effect: form.effect,
        domainId: form.domainId === "" ? null : form.domainId,
        addressPattern: form.addressPattern,
      },
    });
    if (!result.ok) {
      return describeErrors(result.errors);
    }
    await reload();
    return null;
  }

  async function removeRule(permissionId: string): Promise<string | null> {
    const result = await graphqlRequest<
      { readonly removeUserMailPermission: boolean },
      Record<string, unknown>
    >(REMOVE_USER_MAIL_PERMISSION_MUTATION, { id: permissionId });
    if (!result.ok) {
      return describeErrors(result.errors);
    }
    await reload();
    return null;
  }

  async function addTemplateRule(
    userId: string,
    capability: TemplateCapability,
    effect: UserPermissionEffect,
  ): Promise<string | null> {
    const result = await graphqlRequest<
      Record<string, unknown>,
      Record<string, unknown>
    >(ADD_USER_TEMPLATE_PERMISSION_MUTATION, {
      userId,
      input: { capability, effect },
    });
    if (!result.ok) {
      return describeErrors(result.errors);
    }
    await reload();
    return null;
  }

  async function removeTemplateRule(id: string): Promise<string | null> {
    const result = await graphqlRequest<
      Record<string, unknown>,
      Record<string, unknown>
    >(REMOVE_USER_TEMPLATE_PERMISSION_MUTATION, { id });
    if (!result.ok) {
      return describeErrors(result.errors);
    }
    await reload();
    return null;
  }

  return (
    <div class="settings-page users-page">
      <h1>Users</h1>
      <p class="muted users-page__help">
        A matching DENY always wins, even over an ADMIN's default access to
        every mailbox. MEMBER and VIEWER need an explicit ALLOW rule before they
        can see any mail.
      </p>

      <form
        class="panel users-invite"
        onSubmit={(event) => void createUser(event)}
      >
        <h2>Invite user</h2>
        <div class="users-invite__fields">
          <label class="field">
            <span>Email</span>
            <input
              id="user-email"
              type="email"
              required
              placeholder="person@example.com"
              value={email()}
              onInput={(event) => setEmail(event.currentTarget.value)}
            />
          </label>
          <label class="field">
            <span>Name</span>
            <input
              id="user-name"
              type="text"
              required
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label class="field">
            <span>Role</span>
            <select
              id="user-role"
              value={role()}
              onChange={(event) =>
                setRole(event.currentTarget.value as UserRole)
              }
            >
              <For each={ROLE_OPTIONS}>
                {(value) => <option value={value}>{value}</option>}
              </For>
            </select>
          </label>
          <button type="submit" class="primary" disabled={busy()}>
            Invite user
          </button>
        </div>
      </form>

      <section class="panel users-list" aria-labelledby="users-list-title">
        <h2 id="users-list-title">All users</h2>
        <Show
          when={!loading() || users().length > 0}
          fallback={<p class="muted">Loading...</p>}
        >
          <Show
            when={users().length > 0}
            fallback={<p class="muted">No users yet.</p>}
          >
            <div class="users-list__items">
              <For each={users()}>
                {(user) => (
                  <UserRow
                    user={user}
                    onEdit={() => {
                      setSelectedUserId(user.id);
                      setDialogOpen(true);
                    }}
                    onResendInvitation={() =>
                      resendInvitation(user).then(() => undefined)
                    }
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </section>
      <Show when={dialogOpen() && selectedUser()}>
        {(_selectedUser) => (
          <UserEditDialog
            user={getSelectedUser()}
            domains={store.domains()}
            onClose={() => setDialogOpen(false)}
            onSetRole={(nextRole) => setRoleFor(getSelectedUser(), nextRole)}
            onSetActive={(active) => setActiveFor(getSelectedUser(), active)}
            onResendInvitation={() => resendInvitation(getSelectedUser())}
            onAddMailRule={(form) => addRuleFor(getSelectedUser().id, form)}
            onRemoveMailRule={removeRule}
            onAddTemplateRule={(capability, effect) =>
              addTemplateRule(getSelectedUser().id, capability, effect)
            }
            onRemoveTemplateRule={removeTemplateRule}
          />
        )}
      </Show>
      <a href="/">Back to mail</a>
    </div>
  );
}
