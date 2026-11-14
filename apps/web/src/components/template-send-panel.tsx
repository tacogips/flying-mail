import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type {
  MailTemplateView,
  RenderedTemplateView,
  SendTemplatedMessageVariables,
  TemplateValidationView,
  TemplateValueInput,
  TemplateVariableView,
} from "../api/schema-types";
import {
  describeTemplateGate,
  initialTemplateValues,
  splitAddressField,
  toTemplateValueList,
} from "../lib/template-form";
import { CloseIcon } from "./icons";
import "./template-send-panel.css";

/** The four steps the user walks: pick a template, fill its variables,
 * review the mail the server rendered, send. Nothing before `send` delivers
 * anything, and `send` re-renders from the stored template rather than
 * posting the reviewed strings. */
type Step = "PICK" | "FILL" | "REVIEW";

function VariableField(props: {
  readonly variable: TemplateVariableView;
  readonly value: string;
  readonly missing: boolean;
  readonly problem: string | null;
  readonly onInput: (value: string) => void;
}): JSX.Element {
  const id = () => `template-var-${props.variable.key}`;
  const invalid = () => props.missing || props.problem !== null;

  return (
    <div class="field template-field" classList={{ invalid: invalid() }}>
      <label for={id()}>
        {props.variable.label}
        <Show when={props.variable.required}>
          <span class="template-required" aria-hidden="true">
            {" *"}
          </span>
        </Show>
      </label>
      <Show when={props.variable.description !== null}>
        <p class="muted template-field-hint">{props.variable.description}</p>
      </Show>

      <Show
        when={props.variable.type !== "MULTILINE_TEXT"}
        fallback={
          <textarea
            id={id()}
            rows={4}
            value={props.value}
            onInput={(event) => props.onInput(event.currentTarget.value)}
          />
        }
      >
        <Show
          when={props.variable.type !== "BOOLEAN"}
          fallback={
            <input
              id={id()}
              type="checkbox"
              checked={props.value === "true"}
              onInput={(event) =>
                props.onInput(event.currentTarget.checked ? "true" : "false")
              }
            />
          }
        >
          <input
            id={id()}
            type={
              props.variable.type === "NUMBER"
                ? "number"
                : props.variable.type === "DATE"
                  ? "date"
                  : props.variable.type === "EMAIL"
                    ? "email"
                    : "text"
            }
            value={props.value}
            onInput={(event) => props.onInput(event.currentTarget.value)}
          />
        </Show>
      </Show>

      <Show when={props.missing}>
        <p class="template-field-error">This variable is required.</p>
      </Show>
      <Show when={props.problem !== null}>
        <p class="template-field-error">{props.problem}</p>
      </Show>
    </div>
  );
}

export function TemplateSendPanel(props: {
  readonly templates: readonly MailTemplateView[];
  readonly sendableAddresses: readonly string[];
  readonly onValidate: (
    id: string,
    values: readonly TemplateValueInput[],
  ) => Promise<TemplateValidationView | null>;
  readonly onPreview: (
    id: string,
    values: readonly TemplateValueInput[],
  ) => Promise<RenderedTemplateView | null>;
  readonly onSend: (input: SendTemplatedMessageVariables) => Promise<boolean>;
  readonly onClose: () => void;
}): JSX.Element {
  const [step, setStep] = createSignal<Step>("PICK");
  const [selected, setSelected] = createSignal<MailTemplateView | null>(null);
  const [values, setValues] = createSignal<Readonly<Record<string, string>>>(
    {},
  );
  const [validation, setValidation] =
    createSignal<TemplateValidationView | null>(null);
  const [preview, setPreview] = createSignal<RenderedTemplateView | null>(null);
  const [fromOverride, setFromOverride] = createSignal("");
  const [toOverride, setToOverride] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const missingKeys = createMemo(() => new Set(validation()?.missing ?? []));
  const problemByKey = createMemo(() => {
    const map = new Map<string, string>();
    for (const problem of validation()?.invalid ?? []) {
      map.set(problem.key, problem.reason);
    }
    return map;
  });
  const canReview = () => validation()?.valid === true;

  async function revalidate(
    template: MailTemplateView,
    next: Readonly<Record<string, string>>,
  ): Promise<void> {
    // Server-side: the review gate must not be a client-side guess about
    // rules the server owns.
    setValidation(
      await props.onValidate(template.id, toTemplateValueList(next)),
    );
  }

  function pick(template: MailTemplateView): void {
    const initial = initialTemplateValues(template);
    setSelected(template);
    setValues(initial);
    setPreview(null);
    setFromOverride("");
    setToOverride("");
    setStep("FILL");
    void revalidate(template, initial);
  }

  function updateValue(key: string, value: string): void {
    const template = selected();
    if (template === null) {
      return;
    }
    const next = { ...values(), [key]: value };
    setValues(next);
    void revalidate(template, next);
  }

  async function goToReview(): Promise<void> {
    const template = selected();
    if (template === null) {
      return;
    }
    setBusy(true);
    const rendered = await props.onPreview(
      template.id,
      toTemplateValueList(values()),
    );
    setBusy(false);
    if (rendered === null) {
      return;
    }
    setPreview(rendered);
    // Seeds the override fields with what the template resolved to, so the
    // review shows the real recipients and editing one is a deliberate act.
    setFromOverride(rendered.from ?? props.sendableAddresses[0] ?? "");
    setToOverride(rendered.to.join(", "));
    setStep("REVIEW");
  }

  async function send(): Promise<void> {
    const template = selected();
    const rendered = preview();
    if (template === null || rendered === null) {
      return;
    }
    const recipients = splitAddressField(toOverride());
    if (recipients.length === 0) {
      return;
    }
    setBusy(true);
    const sent = await props.onSend({
      templateId: template.id,
      values: toTemplateValueList(values()),
      ...(fromOverride().length === 0 ? {} : { from: fromOverride() }),
      to: recipients,
    });
    setBusy(false);
    if (sent) {
      props.onClose();
    }
  }

  return (
    <section class="template-panel" aria-label="Send from a template">
      <div class="template-titlebar">
        <span class="template-titlebar-title">Send from a template</span>
        <ol class="template-steps">
          <For each={["PICK", "FILL", "REVIEW"] as const}>
            {(name, index) => (
              <li
                class="template-step"
                classList={{ current: step() === name }}
                aria-current={step() === name ? "step" : undefined}
              >
                {index() + 1}.{" "}
                {name === "PICK"
                  ? "Choose"
                  : name === "FILL"
                    ? "Fill in"
                    : "Review"}
              </li>
            )}
          </For>
        </ol>
        <span class="template-titlebar-spacer" />
        <button
          type="button"
          class="icon-button"
          aria-label="Close"
          onClick={() => props.onClose()}
        >
          <CloseIcon />
        </button>
      </div>

      <div class="template-body">
        <Show when={step() === "PICK"}>
          <Show
            when={props.templates.length > 0}
            fallback={
              <p class="muted">
                No templates yet. An administrator can add one under Settings -
                Templates.
              </p>
            }
          >
            <ul class="template-list">
              <For each={props.templates}>
                {(template) => (
                  <li>
                    <button
                      type="button"
                      class="template-list-item"
                      onClick={() => pick(template)}
                    >
                      <span class="template-list-name">{template.name}</span>
                      <Show when={template.description !== null}>
                        <span class="muted template-list-description">
                          {template.description}
                        </span>
                      </Show>
                      <span class="muted template-list-meta">
                        {template.variables.length === 1
                          ? "1 variable"
                          : `${template.variables.length} variables`}
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>

        <Show when={step() === "FILL" && selected() !== null}>
          <div class="template-fill">
            <h3>{selected()?.name}</h3>
            <Show
              when={(selected()?.variables.length ?? 0) > 0}
              fallback={
                <p class="muted">
                  This template takes no variables. Continue to the review.
                </p>
              }
            >
              <For each={selected()?.variables ?? []}>
                {(variable) => (
                  <VariableField
                    variable={variable}
                    value={values()[variable.key] ?? ""}
                    missing={missingKeys().has(variable.key)}
                    problem={problemByKey().get(variable.key) ?? null}
                    onInput={(value) => updateValue(variable.key, value)}
                  />
                )}
              </For>
            </Show>
            <Show when={describeTemplateGate(validation()) !== null}>
              <p class="muted template-gate">
                {describeTemplateGate(validation())}
              </p>
            </Show>
          </div>
        </Show>

        <Show when={step() === "REVIEW" && preview() !== null}>
          <div class="template-review">
            <div class="field">
              <label for="template-from">From</label>
              <Show
                when={props.sendableAddresses.length > 0}
                fallback={
                  <input
                    id="template-from"
                    type="text"
                    value={fromOverride()}
                    onInput={(event) =>
                      setFromOverride(event.currentTarget.value)
                    }
                  />
                }
              >
                <select
                  id="template-from"
                  value={fromOverride()}
                  onChange={(event) =>
                    setFromOverride(event.currentTarget.value)
                  }
                >
                  <For
                    each={
                      props.sendableAddresses.includes(fromOverride())
                        ? props.sendableAddresses
                        : [fromOverride(), ...props.sendableAddresses]
                    }
                  >
                    {(address) => <option value={address}>{address}</option>}
                  </For>
                </select>
              </Show>
            </div>

            <div class="field">
              <label for="template-to">To</label>
              <input
                id="template-to"
                type="text"
                value={toOverride()}
                onInput={(event) => setToOverride(event.currentTarget.value)}
              />
            </div>

            <div class="template-preview">
              <p class="template-preview-subject">{preview()?.subject}</p>
              <Show when={(preview()?.cc.length ?? 0) > 0}>
                <p class="muted">Cc: {preview()?.cc.join(", ")}</p>
              </Show>
              <Show when={(preview()?.bcc.length ?? 0) > 0}>
                <p class="muted">Bcc: {preview()?.bcc.join(", ")}</p>
              </Show>
              <Show
                when={preview()?.text !== null && preview()?.text !== undefined}
              >
                <pre class="template-preview-body">{preview()?.text}</pre>
              </Show>
              <Show
                when={preview()?.html !== null && preview()?.html !== undefined}
              >
                {/* Shown as source, not rendered: the review must let the
                    sender see exactly what the server produced, and a
                    template author is not a trusted HTML source. */}
                <pre class="template-preview-body">{preview()?.html}</pre>
              </Show>
            </div>
          </div>
        </Show>
      </div>

      <div class="template-footer">
        <Show when={step() !== "PICK"}>
          <button
            type="button"
            onClick={() => setStep(step() === "REVIEW" ? "FILL" : "PICK")}
          >
            Back
          </button>
        </Show>
        <span class="template-footer-spacer" />
        <Show when={step() === "FILL"}>
          <button
            type="button"
            class="primary"
            disabled={!canReview() || busy()}
            onClick={() => void goToReview()}
          >
            {busy() ? "Rendering..." : "Review"}
          </button>
        </Show>
        <Show when={step() === "REVIEW"}>
          <button
            type="button"
            class="primary pill"
            disabled={busy() || splitAddressField(toOverride()).length === 0}
            onClick={() => void send()}
          >
            {busy() ? "Sending..." : "Send"}
          </button>
        </Show>
      </div>
    </section>
  );
}
