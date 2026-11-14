import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import {
  CREATE_MAIL_TEMPLATE_MUTATION,
  DELETE_MAIL_TEMPLATE_MUTATION,
  UPDATE_MAIL_TEMPLATE_MUTATION,
} from "../../api/documents";
import { graphqlRequest } from "../../api/graphql-client";
import type {
  MailTemplateInputVariables,
  MailTemplateView,
  TemplateVariableType,
} from "../../api/schema-types";
import { describeErrors } from "../../lib/mutation-error";
import {
  blankToNull,
  splitAddressField,
  unusedVariableKeys,
} from "../../lib/template-form";
import { pushToast } from "../../lib/toast";
import { useStore } from "../../store/store-context";
import "./settings.css";

const VARIABLE_TYPES: readonly TemplateVariableType[] = [
  "TEXT",
  "MULTILINE_TEXT",
  "NUMBER",
  "BOOLEAN",
  "DATE",
  "EMAIL",
];

/** The editor's working copy of one variable. Everything is a string here;
 * the server owns coercion, and mirroring it in the form would just be a
 * second place for the rules to drift. */
interface VariableDraft {
  key: string;
  label: string;
  type: TemplateVariableType;
  required: boolean;
  defaultValue: string;
  description: string;
}

interface TemplateDraft {
  /** Absent for a new template; present when editing an existing one. */
  id: string | null;
  name: string;
  description: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  variables: readonly VariableDraft[];
}

function emptyDraft(): TemplateDraft {
  return {
    id: null,
    name: "",
    description: "",
    subject: "",
    textBody: "",
    htmlBody: "",
    from: "",
    to: "",
    cc: "",
    bcc: "",
    variables: [],
  };
}

function toDraft(template: MailTemplateView): TemplateDraft {
  return {
    id: template.id,
    name: template.name,
    description: template.description ?? "",
    subject: template.subject,
    textBody: template.textBody ?? "",
    htmlBody: template.htmlBody ?? "",
    from: template.from ?? "",
    to: template.to.join(", "),
    cc: template.cc.join(", "),
    bcc: template.bcc.join(", "),
    variables: template.variables.map((variable) => ({
      key: variable.key,
      label: variable.label,
      type: variable.type,
      required: variable.required,
      defaultValue: variable.defaultValue ?? "",
      description: variable.description ?? "",
    })),
  };
}

function toInput(draft: TemplateDraft): MailTemplateInputVariables {
  return {
    name: draft.name,
    description: blankToNull(draft.description),
    subject: draft.subject,
    textBody: blankToNull(draft.textBody),
    htmlBody: blankToNull(draft.htmlBody),
    from: blankToNull(draft.from),
    to: splitAddressField(draft.to),
    cc: splitAddressField(draft.cc),
    bcc: splitAddressField(draft.bcc),
    variables: draft.variables.map((variable) => ({
      key: variable.key.trim(),
      label: blankToNull(variable.label),
      type: variable.type,
      required: variable.required,
      defaultValue: blankToNull(variable.defaultValue),
      description: blankToNull(variable.description),
    })),
  };
}

export default function TemplatesPage(): JSX.Element {
  const store = useStore();
  const [draft, setDraft] = createSignal<TemplateDraft | null>(null);
  const [busy, setBusy] = createSignal(false);

  const capabilities = () => store.viewer()?.capabilities ?? [];
  const canCreate = () => capabilities().includes("TEMPLATE_CREATE");
  const canUpdate = () => capabilities().includes("TEMPLATE_UPDATE");
  const canDelete = () => capabilities().includes("TEMPLATE_DELETE");

  onMount(() => {
    void store.loadMailTemplates();
  });

  function patch(changes: Partial<TemplateDraft>): void {
    setDraft((current) =>
      current === null ? current : { ...current, ...changes },
    );
  }

  function patchVariable(index: number, changes: Partial<VariableDraft>): void {
    setDraft((current) =>
      current === null
        ? current
        : {
            ...current,
            variables: current.variables.map((variable, position) =>
              position === index ? { ...variable, ...changes } : variable,
            ),
          },
    );
  }

  function addVariable(): void {
    setDraft((current) =>
      current === null
        ? current
        : {
            ...current,
            variables: [
              ...current.variables,
              {
                key: "",
                label: "",
                type: "TEXT",
                required: true,
                defaultValue: "",
                description: "",
              },
            ],
          },
    );
  }

  function removeVariable(index: number): void {
    setDraft((current) =>
      current === null
        ? current
        : {
            ...current,
            variables: current.variables.filter(
              (_unused, position) => position !== index,
            ),
          },
    );
  }

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    const current = draft();
    if (current === null) {
      return;
    }
    setBusy(true);
    const input = toInput(current);
    const result =
      current.id === null
        ? await graphqlRequest<
            { readonly createMailTemplate: MailTemplateView },
            Record<string, unknown>
          >(CREATE_MAIL_TEMPLATE_MUTATION, { input })
        : await graphqlRequest<
            { readonly updateMailTemplate: MailTemplateView },
            Record<string, unknown>
          >(UPDATE_MAIL_TEMPLATE_MUTATION, { id: current.id, input });
    setBusy(false);
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    pushToast(
      "success",
      current.id === null ? "Template created" : "Template saved",
    );
    setDraft(null);
    await store.loadMailTemplates();
  }

  async function remove(template: MailTemplateView): Promise<void> {
    const result = await graphqlRequest<
      { readonly deleteMailTemplate: boolean },
      Record<string, unknown>
    >(DELETE_MAIL_TEMPLATE_MUTATION, { id: template.id });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    if (draft()?.id === template.id) {
      setDraft(null);
    }
    await store.loadMailTemplates();
  }

  return (
    <div class="settings-page">
      <h1>Mail templates</h1>
      <p class="muted">
        Templates are written in Eta. Read a declared variable with{" "}
        <code>{"<%= it.variableName %>"}</code>, or{" "}
        <code>{"<%~ it.variableName %>"}</code> to skip HTML escaping. Only
        interpolation is supported: <code>{"<% ... %>"}</code> statements are
        rejected when you save, so a stored template always renders.
      </p>

      <Show
        when={draft() !== null}
        fallback={
          <Show
            when={canCreate()}
            fallback={
              <p class="muted">
                You do not have permission to create templates. An administrator
                can grant TEMPLATE_CREATE on the Users page.
              </p>
            }
          >
            <button
              type="button"
              class="primary"
              onClick={() => setDraft(emptyDraft())}
            >
              New template
            </button>
          </Show>
        }
      >
        <form class="panel" onSubmit={(event) => void save(event)}>
          <h2>{draft()?.id === null ? "New template" : "Edit template"}</h2>

          <div class="field">
            <label for="template-name">Name</label>
            <input
              id="template-name"
              type="text"
              required
              value={draft()?.name ?? ""}
              onInput={(event) => patch({ name: event.currentTarget.value })}
            />
          </div>

          <div class="field">
            <label for="template-description">Description</label>
            <input
              id="template-description"
              type="text"
              value={draft()?.description ?? ""}
              onInput={(event) =>
                patch({ description: event.currentTarget.value })
              }
            />
          </div>

          <div class="field">
            <label for="template-subject">Subject</label>
            <input
              id="template-subject"
              type="text"
              required
              value={draft()?.subject ?? ""}
              onInput={(event) => patch({ subject: event.currentTarget.value })}
            />
          </div>

          <div class="field">
            <label for="template-text">Text body</label>
            <textarea
              id="template-text"
              rows={8}
              value={draft()?.textBody ?? ""}
              onInput={(event) =>
                patch({ textBody: event.currentTarget.value })
              }
            />
          </div>

          <div class="field">
            <label for="template-html">HTML body</label>
            <textarea
              id="template-html"
              rows={6}
              value={draft()?.htmlBody ?? ""}
              onInput={(event) =>
                patch({ htmlBody: event.currentTarget.value })
              }
            />
            <p class="muted">At least one of the two bodies is required.</p>
          </div>

          <div class="field">
            <label for="template-from">Default sender</label>
            <input
              id="template-from"
              type="text"
              value={draft()?.from ?? ""}
              onInput={(event) => patch({ from: event.currentTarget.value })}
            />
          </div>

          <div class="field">
            <label for="template-to">Default To</label>
            <input
              id="template-to"
              type="text"
              placeholder="<%= it.customerEmail %>, archive@example.com"
              value={draft()?.to ?? ""}
              onInput={(event) => patch({ to: event.currentTarget.value })}
            />
          </div>

          <div class="field">
            <label for="template-cc">Default Cc</label>
            <input
              id="template-cc"
              type="text"
              value={draft()?.cc ?? ""}
              onInput={(event) => patch({ cc: event.currentTarget.value })}
            />
          </div>

          <div class="field">
            <label for="template-bcc">Default Bcc</label>
            <input
              id="template-bcc"
              type="text"
              value={draft()?.bcc ?? ""}
              onInput={(event) => patch({ bcc: event.currentTarget.value })}
            />
          </div>

          <h3>Variables</h3>
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Label</th>
                <th>Type</th>
                <th>Required</th>
                <th>Default</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <For each={draft()?.variables ?? []}>
                {(variable, index) => (
                  <tr>
                    <td>
                      <input
                        type="text"
                        aria-label="Variable key"
                        value={variable.key}
                        onInput={(event) =>
                          patchVariable(index(), {
                            key: event.currentTarget.value,
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        aria-label="Variable label"
                        value={variable.label}
                        onInput={(event) =>
                          patchVariable(index(), {
                            label: event.currentTarget.value,
                          })
                        }
                      />
                    </td>
                    <td>
                      <select
                        aria-label="Variable type"
                        value={variable.type}
                        onChange={(event) =>
                          patchVariable(index(), {
                            type: event.currentTarget
                              .value as TemplateVariableType,
                          })
                        }
                      >
                        <For each={VARIABLE_TYPES}>
                          {(type) => <option value={type}>{type}</option>}
                        </For>
                      </select>
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label="Variable required"
                        checked={variable.required}
                        onChange={(event) =>
                          patchVariable(index(), {
                            required: event.currentTarget.checked,
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        aria-label="Variable default"
                        value={variable.defaultValue}
                        onInput={(event) =>
                          patchVariable(index(), {
                            defaultValue: event.currentTarget.value,
                          })
                        }
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        class="danger"
                        onClick={() => removeVariable(index())}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <button type="button" onClick={() => addVariable()}>
            Add variable
          </button>

          <div class="settings-actions">
            <button type="submit" class="primary" disabled={busy()}>
              {busy() ? "Saving..." : "Save template"}
            </button>
            <button type="button" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      </Show>

      <div class="panel">
        <h2>All templates</h2>
        <Show
          when={store.mailTemplates().length > 0}
          fallback={<p class="muted">No templates yet.</p>}
        >
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Subject</th>
                <th>Variables</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <For each={store.mailTemplates()}>
                {(template) => (
                  <tr>
                    <td>
                      {template.name}
                      <Show when={template.description !== null}>
                        <p class="muted">{template.description}</p>
                      </Show>
                    </td>
                    <td class="muted">{template.subject}</td>
                    <td>
                      {template.variables.length}
                      <Show when={unusedVariableKeys(template).length > 0}>
                        <p class="muted">
                          unused: {unusedVariableKeys(template).join(", ")}
                        </p>
                      </Show>
                    </td>
                    <td>
                      <Show when={canUpdate()}>
                        <button
                          type="button"
                          onClick={() => setDraft(toDraft(template))}
                        >
                          Edit
                        </button>
                      </Show>
                      <Show when={canDelete()}>
                        <button
                          type="button"
                          class="danger"
                          onClick={() => void remove(template)}
                        >
                          Delete
                        </button>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </div>

      <a href="/">Back to mail</a>
    </div>
  );
}
